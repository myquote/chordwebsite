import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { parse } from "acorn";

const ZIP_PATH = process.env.ZIP_PATH || "/tmp/chord-source.zip";
const OUTPUT_DIR = path.resolve("data");
const TEMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "chord-import-")
);

const SONGS_PER_FILE = 500;

const ACCEPTED_NAMES = [
  "tampilchord",
  "chord",
  "songs",
  "data"
];

// ======================================================
// UTILITAS
// ======================================================

function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("id");
}

function writeJson(filename, data) {
  fs.writeFileSync(
    path.join(OUTPUT_DIR, filename),
    JSON.stringify(data, null, 2) + "\n",
    "utf8"
  );
}

function readJson(filename, fallback = null) {
  const filepath = path.join(OUTPUT_DIR, filename);

  if (!fs.existsSync(filepath)) {
    return fallback;
  }

  try {
    return JSON.parse(
      fs.readFileSync(filepath, "utf8")
    );
  } catch (error) {
    console.warn(
      `Peringatan: ${filename} tidak dapat dibaca.`
    );

    return fallback;
  }
}

// ======================================================
// MEMBACA NILAI AST JAVASCRIPT
// ======================================================

function getValue(node) {
  if (!node) return undefined;

  switch (node.type) {
    case "Literal":
      return node.value;

    case "UnaryExpression": {
      const argument = getValue(node.argument);

      if (node.operator === "-" && typeof argument === "number") {
        return -argument;
      }

      if (node.operator === "+" && typeof argument === "number") {
        return argument;
      }

      return undefined;
    }

    case "ObjectExpression": {
      const result = {};

      for (const property of node.properties) {
        if (
          property.type !== "Property" ||
          property.kind !== "init" ||
          property.computed
        ) {
          continue;
        }

        const key =
          property.key.type === "Identifier"
            ? property.key.name
            : String(property.key.value);

        result[key] = getValue(property.value);
      }

      return result;
    }

    case "ArrayExpression":
      return node.elements.map(getValue);

    case "TemplateLiteral":
      if (node.expressions.length === 0) {
        return node.quasis
          .map(item => item.value.cooked ?? item.value.raw)
          .join("");
      }

      return undefined;

    default:
      return undefined;
  }
}

// ======================================================
// EKSTRAK DATA LAGU DARI FILE JS
// ======================================================

function extractSongs(source, filename) {
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowHashBang: true
  });

  for (const statement of ast.body) {
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        if (
          declaration.id.type !== "Identifier" ||
          !ACCEPTED_NAMES.includes(declaration.id.name)
        ) {
          continue;
        }

        const value = getValue(declaration.init);

        if (
          value &&
          typeof value === "object" &&
          !Array.isArray(value)
        ) {
          return value;
        }
      }
    }

    if (
      statement.type === "ExpressionStatement" &&
      statement.expression.type === "AssignmentExpression"
    ) {
      const expression = statement.expression;

      if (
        expression.left.type === "Identifier" &&
        ACCEPTED_NAMES.includes(expression.left.name)
      ) {
        const value = getValue(expression.right);

        if (
          value &&
          typeof value === "object" &&
          !Array.isArray(value)
        ) {
          return value;
        }
      }
    }
  }

  throw new Error(
    `Objek data lagu tidak ditemukan: ${filename}`
  );
}

// ======================================================
// MENCARI FILE JS DI DALAM ZIP
// ======================================================

function walk(dir) {
  const files = [];

  for (const entry of fs.readdirSync(dir, {
    withFileTypes: true
  })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (
      entry.isFile() &&
      entry.name.toLowerCase().endsWith(".js")
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

// ======================================================
// KONVERSI CONTENT
// ======================================================

function decodeContent(raw) {
  let content = String(raw ?? "");

  if (!content) {
    return "";
  }

  // Jika sudah berupa HTML chord dari proses sebelumnya,
  // pertahankan agar tidak dikonversi dua kali.
  if (
    /<pre\b[^>]*class=["'][^"']*chord-lyrics/i.test(content)
  ) {
    return content;
  }

  // Normalisasi newline.
  content = content
    .replace(/\r\n?/g, "\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");

  // Encoding umum untuk baris baru.
  const newlineTokens = {
    "Ï": "\n\n\n\n\n",
    "ï": "\n\n\n\n",
    "î": "\n\n\n",
    "í": "\n\n",
    "ì": "\n"
  };

  for (const [token, replacement] of Object.entries(
    newlineTokens
  )) {
    content = content.split(token).join(replacement);
  }

  // Encoding umum untuk spasi.
  const spaceTokens = {
    "Ö": "          ",
    "Õ": "         ",
    "Ô": "        ",
    "Ó": "       ",
    "Ò": "      ",
    "ö": "     ",
    "õ": "    ",
    "ô": "   ",
    "ó": "  ",
    "ò": " "
  };

  for (const [token, replacement] of Object.entries(
    spaceTokens
  )) {
    content = content.split(token).join(replacement);
  }

  // Hanya pertahankan struktur teks.
  // Jangan mengubah slash pada chord seperti C/E atau D/F#.
  content = content
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n");

  // Escape HTML agar isi lagu tidak merusak struktur halaman.
  const escapeHtml = value =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

  const escaped = escapeHtml(content);

  // Pola chord dengan root, variasi, angka, dan slash bass.
  // Contoh: C, Am, F#m, C/E, G/B, D/F#, F#m/C#.
  const chordPattern =
    /(?<![A-Za-z0-9])([A-G](?:#|b)?(?:maj|min|dim|aug|sus|add|m|M)?(?:\d{1,2})?(?:\/(?:[A-G](?:#|b)?))?)(?![A-Za-z0-9])/g;

  const html = escaped.replace(
    chordPattern,
    chord => {
      const safeChord = escapeHtml(chord);

      return (
        `<a class="chord">${safeChord}` +
        `<span class="data-${safeChord}"></span>` +
        `</a>`
      );
    }
  );

  return `<pre class="chord-lyrics">${html}</pre>`;
}

// ======================================================
// MEMBACA DATA LAMA
// ======================================================

function loadExistingSongs() {
  const map = new Map();

  if (!fs.existsSync(OUTPUT_DIR)) {
    return map;
  }

  const files = fs.readdirSync(OUTPUT_DIR)
    .filter(name => /^songs-\d+\.json$/i.test(name))
    .sort((a, b) =>
      a.localeCompare(b, "en", { numeric: true })
    );

  for (const filename of files) {
    const rows = readJson(filename, []);

    if (!Array.isArray(rows)) continue;

    for (const song of rows) {
      if (!song || !song.title) continue;

      const key =
        normalizeKey(song.artist_name) +
        "|" +
        normalizeKey(song.title);

      if (!map.has(key)) {
        map.set(key, song);
      }
    }
  }

  return map;
}

function loadExistingArtists() {
  const map = new Map();
  const rows = readJson("artists.json", []);

  if (!Array.isArray(rows)) {
    return map;
  }

  for (const artist of rows) {
    if (!artist || !artist.name) continue;

    const key = normalizeKey(artist.name);

    if (!map.has(key)) {
      map.set(key, artist);
    }
  }

  return map;
}

// ======================================================
// PENGGABUNGAN LAGU
// ======================================================

function mergeSong(songMap, incoming) {
  const key =
    normalizeKey(incoming.artist_name) +
    "|" +
    normalizeKey(incoming.title);

  const existing = songMap.get(key);

  if (!existing) {
    songMap.set(key, incoming);
    return;
  }

  // Jangan mengganti ID lama jika sudah ada.
  if (!existing.id && incoming.id) {
    existing.id = incoming.id;
  }

  if (!existing.artist_id && incoming.artist_id) {
    existing.artist_id = incoming.artist_id;
  }

  if (!existing.artist_name && incoming.artist_name) {
    existing.artist_name = incoming.artist_name;
  }

  if (!existing.youtube_id && incoming.youtube_id) {
    existing.youtube_id = incoming.youtube_id;
  }

  // Konten lama yang ada tidak ditimpa oleh konten kosong.
  if (
    (!existing.content || !existing.content.trim()) &&
    incoming.content &&
    incoming.content.trim()
  ) {
    existing.content = incoming.content;
  }

  if (!existing.slug && incoming.slug) {
    existing.slug = incoming.slug;
  }

  if (!existing.source_file && incoming.source_file) {
    existing.source_file = incoming.source_file;
  }
}

// ======================================================
// MENJALANKAN KONVERSI
// ======================================================

async function main() {
  if (!fs.existsSync(ZIP_PATH)) {
    throw new Error(
      `ZIP tidak ditemukan: ${ZIP_PATH}`
    );
  }

  fs.mkdirSync(TEMP_DIR, {
    recursive: true
  });

  execFileSync(
    "unzip",
    ["-q", ZIP_PATH, "-d", TEMP_DIR]
  );

  const sourceFiles = walk(TEMP_DIR).sort(
    (a, b) =>
      a.localeCompare(b, "en", {
        numeric: true
      })
  );

  if (sourceFiles.length === 0) {
    throw new Error(
      "ZIP tidak berisi file JS."
    );
  }

  console.log(
    `Ditemukan ${sourceFiles.length} file JS.`
  );

  fs.mkdirSync(OUTPUT_DIR, {
    recursive: true
  });

  // Data lama dimuat sebelum data baru diproses.
  const songMap = loadExistingSongs();
  const artistMap = loadExistingArtists();

  const initialSongCount = songMap.size;

  // ====================================================
  // PROSES FILE SUMBER
  // ====================================================

  for (let i = 0; i < sourceFiles.length; i++) {
    const filepath = sourceFiles[i];
    const filename = path.basename(filepath);

    const source = fs
      .readFileSync(filepath, "utf8")
      .replace(/^\uFEFF/, "");

    const data = extractSongs(source, filename);

    for (const [key, item] of Object.entries(data)) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const id = String(
        item.id ?? key
      );

      const artistId = String(
        item.id_band ??
        item.artist_id ??
        ""
      );

      const artistName = String(
        item.nama_band ??
        item.artist_name ??
        ""
      ).trim();

      const title = String(
        item.judul ??
        item.title ??
        ""
      ).trim();

      const rawContent = String(
        item.isi ??
        item.content ??
        ""
      );

      const youtubeId = String(
        item.youtube_id ??
        item.youtubeId ??
        ""
      );

      if (!artistName || !title) {
        console.warn(
          `Lewati data tanpa artis/judul: ${filename}, ID ${id}`
        );

        continue;
      }

      // Dedup artis berdasarkan nama tanpa membedakan kapital.
      const artistKey = normalizeKey(artistName);

      if (!artistMap.has(artistKey)) {
        artistMap.set(artistKey, {
          id: artistId || slugify(artistName),
          name: artistName,
          slug: slugify(artistName)
        });
      }

      // Jangan menambahkan tag pre jika content sudah berupa HTML.
      const content = decodeContent(rawContent);

      const incoming = {
        id,
        artist_id: artistId,
        artist_name: artistName,
        title,
        slug: slugify(
          `${artistName} ${title}`
        ),
        youtube_id: youtubeId,
        content,
        source_file: filename
      };

      mergeSong(songMap, incoming);
    }

    if ((i + 1) % 25 === 0) {
      console.log(
        `Proses ${i + 1}/${sourceFiles.length} file JS`
      );
    }
  }

  // ====================================================
  // SIMPAN HASIL GABUNGAN
  // ====================================================

  const allSongs = [...songMap.values()].sort(
    (a, b) =>
      `${a.artist_name} ${a.title}`.localeCompare(
        `${b.artist_name} ${b.title}`,
        "id"
      )
  );

  const allArtists = [...artistMap.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name, "id")
  );

  // Buat file sementara terlebih dahulu.
  const stagingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "chord-output-")
  );

  const fileSummary = [];

  for (
    let i = 0;
    i < allSongs.length;
    i += SONGS_PER_FILE
  ) {
    const filename =
      `songs-${String(
        Math.floor(i / SONGS_PER_FILE) + 1
      ).padStart(3, "0")}.json`;

    const chunk = allSongs.slice(
      i,
      i + SONGS_PER_FILE
    );

    fs.writeFileSync(
      path.join(stagingDir, filename),
      JSON.stringify(chunk, null, 2) + "\n",
      "utf8"
    );

    fileSummary.push({
      file: filename,
      songs: chunk.length
    });
  }

  fs.writeFileSync(
    path.join(stagingDir, "artists.json"),
    JSON.stringify(allArtists, null, 2) + "\n",
    "utf8"
  );

  fs.writeFileSync(
    path.join(stagingDir, "index.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        source_files: sourceFiles.length,
        total_songs: allSongs.length,
        total_artists: allArtists.length,
        songs_per_file: SONGS_PER_FILE,
        files: fileSummary
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  // Semua JSON baru sudah selesai ditulis.
  // Baru kemudian ganti file songs lama dengan hasil gabungan.
  for (const filename of fs.readdirSync(OUTPUT_DIR)) {
    if (/^songs-\d+\.json$/i.test(filename)) {
      fs.rmSync(
        path.join(OUTPUT_DIR, filename),
        { force: true }
      );
    }
  }

  for (const filename of fs.readdirSync(stagingDir)) {
    fs.copyFileSync(
      path.join(stagingDir, filename),
      path.join(OUTPUT_DIR, filename)
    );
  }

  fs.rmSync(stagingDir, {
    recursive: true,
    force: true
  });

  console.log("");
  console.log("Konversi selesai.");
  console.log(`File JS sumber: ${sourceFiles.length}`);
  console.log(`Lagu sebelum impor: ${initialSongCount}`);
  console.log(`Total lagu setelah penggabungan: ${allSongs.length}`);
  console.log(`Total artis: ${allArtists.length}`);
  console.log(`Total file JSON lagu: ${fileSummary.length}`);
}

try {
  await main();
} finally {
  fs.rmSync(TEMP_DIR, {
    recursive: true,
    force: true
  });
}
