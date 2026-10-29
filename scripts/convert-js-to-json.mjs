import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { parse } from "acorn";

const ZIP_PATH =
  process.env.ZIP_PATH || "/tmp/chord-source.zip";

const OUTPUT_DIR =
  process.env.OUTPUT_DIR || "data";

const GROUP_SIZE = Math.max(
  1,
  Number(process.env.GROUP_SIZE || 100)
);

const TEMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "chord-convert-")
);

const EXTRACT_DIR = path.join(TEMP_DIR, "source");

const oldSongs = new Map();
const artists = new Map();

function log(message) {
  console.log(`[converter] ${message}`);
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "lagu";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function decodeEntities(value) {
  const entities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: "\u00a0",
    rsquo: "’",
    lsquo: "‘",
    rdquo: "”",
    ldquo: "“",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    copy: "©",
    reg: "®",
    trade: "™",
    eacute: "é",
    Eacute: "É",
    aacute: "á",
    Aacute: "Á",
    ouml: "ö",
    uuml: "ü",
    ntilde: "ñ",
    agrave: "à",
    egrave: "è",
  };

  return String(value).replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi,
    (original, entity) => {
      if (entity.startsWith("#")) {
        const hexadecimal = entity[1]?.toLowerCase() === "x";

        const codePoint = Number.parseInt(
          entity.slice(hexadecimal ? 2 : 1),
          hexadecimal ? 16 : 10
        );

        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return original;
        }
      }

      return Object.hasOwn(entities, entity)
        ? entities[entity]
        : original;
    }
  );
}

/**
 * Decoder mengikuti fungsi convert(raw)
 * pada Worker importer lama.
 */
function decodeContent(raw) {
  let content = decodeEntities(String(raw ?? ""));

  content = content
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\u00a0|&#160;|&#xA0;|&nbsp;/g, " ");

  const spaces = {
    "Ö": 10,
    "Õ": 9,
    "Ô": 8,
    "Ó": 7,
    "Ò": 6,
    "ö": 5,
    "õ": 4,
    "ô": 3,
    "ó": 2,
    "ò": 1,
    "%": 1,
  };

  for (const [token, count] of Object.entries(spaces)) {
    content = content.split(token).join(" ".repeat(count));
  }

  const lineBreaks = {
    "Ï": 5,
    "ï": 4,
    "î": 3,
    "í": 2,
    "ì": 1,
  };

  for (const [token, count] of Object.entries(lineBreaks)) {
    content = content
      .split(token)
      .join("\n".repeat(count));
  }

  content = content
    .replace(/:s(\d+):/gi, (_, number) => {
      return " ".repeat(Math.min(40, Number(number)));
    })
    .replace(/:x(\d+):/gi, (_, number) => {
      return "\n".repeat(Math.min(20, Number(number)));
    });

  content = content
    .replace(/Gb/g, "F#")
    .replace(/Ab/g, "G#")
    .replace(/Bb/g, "A#")
    .replace(/Db/g, "C#")
    .replace(/Eb/g, "D#")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");

  return content;
}

/**
 * Mengenali notasi chord.
 *
 * Slash chord dipertahankan sebagai satu kesatuan:
 * C/E, G/B, D/F#, Am/G, F#m/C#.
 */
function convertChords(content) {
  const escaped = escapeHtml(content);

  const chordPattern =
    /(^|[^A-Za-z0-9])([A-G](?:#|b)?(?:m|maj|min|dim|aug|sus|add|M)?(?:[0-9]{1,2})?(?:[#b](?:5|9|11|13))?(?:\/(?:[A-G](?:#|b)?))?)(?![A-Za-z0-9])/g;

  return escaped.replace(
    chordPattern,
    (_, prefix, chord) => {
      return (
        prefix +
        '<a class="chord">' +
        chord +
        '<span class="data-' +
        escapeHtml(chord) +
        '"></span></a>'
      );
    }
  );
}

function convertContent(raw) {
  const decoded = decodeContent(raw);
  const html = convertChords(decoded);

  return `<pre class="chord-lyrics">${html}</pre>`;
}

function getProperty(node, name) {
  if (!node || node.type !== "ObjectExpression") {
    return undefined;
  }

  for (const property of node.properties) {
    if (
      property.type !== "Property" ||
      property.computed
    ) {
      continue;
    }

    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.value;

    if (key === name) {
      return property.value;
    }
  }

  return undefined;
}

function literalValue(node) {
  if (!node) return undefined;

  if (node.type === "Literal") {
    return node.value;
  }

  if (node.type === "TemplateLiteral") {
    if (node.expressions.length === 0) {
      return node.quasis[0]?.value?.cooked ?? "";
    }
  }

  if (node.type === "UnaryExpression") {
    const value = literalValue(node.argument);

    if (typeof value === "number") {
      if (node.operator === "-") return -value;
      if (node.operator === "+") return value;
    }
  }

  return undefined;
}

function propertyValue(node, ...names) {
  for (const name of names) {
    const value = literalValue(getProperty(node, name));

    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return undefined;
}

function extractRows(source, filename) {
  let ast;

  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowHashBang: true,
    });
  } catch {
    try {
      ast = parse(source, {
        ecmaVersion: "latest",
        sourceType: "module",
        allowHashBang: true,
      });
    } catch (error) {
      log(`Lewati JS yang gagal diparse: ${filename}`);
      log(error.message);
      return [];
    }
  }

  const rows = [];

  function inspect(node) {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (const child of node) inspect(child);
      return;
    }

    if (node.type === "VariableDeclarator") {
      const variableName =
        node.id?.type === "Identifier"
          ? node.id.name.toLowerCase()
          : "";

      if (
        ["tampilchord", "chord", "songs", "data"].includes(
          variableName
        )
      ) {
        const initializer = node.init;

        if (initializer?.type === "ArrayExpression") {
          for (const item of initializer.elements) {
            if (item?.type === "ObjectExpression") {
              const row = makeSong(item, filename);

              if (row) rows.push(row);
            }
          }
        }

        if (initializer?.type === "ObjectExpression") {
          for (const property of initializer.properties) {
            if (
              property.type !== "Property" ||
              property.value?.type !== "ObjectExpression"
            ) {
              continue;
            }

            const row = makeSong(
              property.value,
              filename,
              literalValue(property.key)
            );

            if (row) rows.push(row);
          }
        }
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (
        key === "start" ||
        key === "end" ||
        key === "loc"
      ) {
        continue;
      }

      if (value && typeof value === "object") {
        inspect(value);
      }
    }
  }

  inspect(ast);

  return rows;
}

function makeSong(node, filename, fallbackKey) {
  const id =
    propertyValue(node, "id", "source_id") ??
    fallbackKey;

  const artistId = propertyValue(
    node,
    "id_band",
    "artist_id"
  );

  const artistName = normalize(
    propertyValue(
      node,
      "nama_band",
      "artist_name",
      "artist"
    ) ?? ""
  );

  const title = normalize(
    propertyValue(node, "judul", "title") ?? ""
  );

  const rawContent = propertyValue(
    node,
    "isi",
    "content"
  );

  if (!title || rawContent === undefined) {
    return null;
  }

  const content = convertContent(rawContent);

  const youtubeId = normalize(
    propertyValue(
      node,
      "youtube_id",
      "youtubeId",
      "id_youtube"
    ) ?? ""
  );

  const artistKey =
    artistId !== undefined
      ? String(artistId)
      : slugify(artistName);

  if (artistName) {
    artists.set(artistKey, {
      id: artistId ?? null,
      name: artistName,
      slug: slugify(artistName),
    });
  }

  return {
    id: String(id ?? `${filename}:${title}`),
    artist_id: artistId ?? null,
    artist_name: artistName,
    title,
    slug: slugify(
      [artistName, title].filter(Boolean).join(" ")
    ),
    youtube_id: youtubeId,
    content,
    source_file: filename,
  };
}

function walkJavaScript(directory) {
  const files = [];

  for (const entry of fs.readdirSync(directory, {
    withFileTypes: true,
  })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkJavaScript(fullPath));
    } else if (entry.isFile() && /\.js$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function loadExistingSongs() {
  if (!fs.existsSync(OUTPUT_DIR)) return;

  for (const filename of fs.readdirSync(OUTPUT_DIR)) {
    if (!/^songs-\d+\.json$/i.test(filename)) continue;

    const filePath = path.join(OUTPUT_DIR, filename);

    try {
      const data = JSON.parse(
        fs.readFileSync(filePath, "utf8")
      );

      if (!Array.isArray(data)) continue;

      for (const song of data) {
        const key = `${normalize(
          song.artist_name
        ).toLowerCase()}|${normalize(
          song.title
        ).toLowerCase()}`;

        if (song.title) {
          oldSongs.set(key, song);
        }

        if (song.artist_name) {
          const artistKey =
            song.artist_id !== null &&
            song.artist_id !== undefined
              ? String(song.artist_id)
              : slugify(song.artist_name);

          artists.set(artistKey, {
            id: song.artist_id ?? null,
            name: song.artist_name,
            slug: slugify(song.artist_name),
          });
        }
      }
    } catch (error) {
      log(`Gagal membaca ${filename}: ${error.message}`);
    }
  }
}

function writeJson(filename, data) {
  fs.writeFileSync(
    path.join(OUTPUT_DIR, filename),
    JSON.stringify(data, null, 2) + "\n",
    "utf8"
  );
}

function main() {
  if (!fs.existsSync(ZIP_PATH)) {
    throw new Error(`ZIP tidak ditemukan: ${ZIP_PATH}`);
  }

  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  loadExistingSongs();

  log(`Mengekstrak ${ZIP_PATH}`);

  execFileSync(
    "unzip",
    ["-oq", ZIP_PATH, "-d", EXTRACT_DIR],
    { stdio: "inherit" }
  );

  const files = walkJavaScript(EXTRACT_DIR);

  log(`File JS ditemukan: ${files.length}`);

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const relativeName = path.relative(EXTRACT_DIR, file);

    const rows = extractRows(source, relativeName);

    for (const row of rows) {
      const key = `${normalize(
        row.artist_name
      ).toLowerCase()}|${normalize(
        row.title
      ).toLowerCase()}`;

      const existing = oldSongs.get(key);

      if (existing) {
        oldSongs.set(key, {
          ...existing,
          ...row,
        });

        updated++;
      } else {
        oldSongs.set(key, row);
        added++;
      }
    }

    if (rows.length === 0) {
      skipped++;
    }
  }

  const allSongs = [...oldSongs.values()].sort(
    (a, b) =>
      a.artist_name.localeCompare(b.artist_name) ||
      a.title.localeCompare(b.title)
  );

  /*
   * Hapus hanya file songs-*.json yang dibuat converter.
   * File lain di data/ tetap dipertahankan.
   */
  for (const filename of fs.readdirSync(OUTPUT_DIR)) {
    if (/^songs-\d+\.json$/i.test(filename)) {
      fs.unlinkSync(path.join(OUTPUT_DIR, filename));
    }
  }

  for (
    let start = 0, group = 1;
    start < allSongs.length;
    start += GROUP_SIZE, group++
  ) {
    const chunk = allSongs.slice(
      start,
      start + GROUP_SIZE
    );

    writeJson(
      `songs-${String(group).padStart(3, "0")}.json`,
      chunk
    );
  }

  writeJson(
    "artists.json",
    [...artists.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    )
  );

  writeJson("index.json", {
    total_songs: allSongs.length,
    total_artists: artists.size,
    generated_at: new Date().toISOString(),
    files: allSongs.length
      ? Math.ceil(allSongs.length / GROUP_SIZE)
      : 0,
  });

  log(`Selesai.`);
  log(`Lagu baru: ${added}`);
  log(`Lagu diperbarui: ${updated}`);
  log(`File JS tanpa data yang dikenali: ${skipped}`);
  log(`Total lagu JSON: ${allSongs.length}`);
  log(`Total artis: ${artists.size}`);
}

try {
  main();
} finally {
  fs.rmSync(TEMP_DIR, {
    recursive: true,
    force: true,
  });
}
