import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { parse } from "acorn";

const ZIP_PATH = process.env.ZIP_PATH || "/tmp/chord-source.zip";
const GROUP_SIZE = 100;

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "chord-import-")
);

const outputDir = path.resolve("data");

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

function getValue(node) {
  if (!node) return undefined;

  switch (node.type) {
    case "Literal":
      return node.value;

    case "UnaryExpression":
      if (
        node.operator === "-" &&
        node.argument.type === "Literal"
      ) {
        return -node.argument.value;
      }

      if (
        node.operator === "+" &&
        node.argument.type === "Literal"
      ) {
        return +node.argument.value;
      }

      return undefined;

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

function extractSongs(source, filename) {
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowHashBang: true
  });

  const acceptedNames = [
    "tampilchord",
    "chord",
    "songs",
    "data"
  ];

  for (const statement of ast.body) {
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        if (
          declaration.id.type !== "Identifier" ||
          !acceptedNames.includes(declaration.id.name)
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
        acceptedNames.includes(expression.left.name)
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

function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function writeJson(filename, data) {
  fs.writeFileSync(
    path.join(outputDir, filename),
    JSON.stringify(data, null, 2) + "\n"
  );
}

fs.mkdirSync(tempDir, { recursive: true });

execFileSync(
  "unzip",
  ["-q", ZIP_PATH, "-d", tempDir]
);

const sourceFiles = walk(tempDir).sort((a, b) =>
  a.localeCompare(b, "en", { numeric: true })
);

if (sourceFiles.length === 0) {
  throw new Error("ZIP tidak berisi file JS.");
}

console.log(`Ditemukan ${sourceFiles.length} file JS.`);

fs.rmSync(outputDir, {
  recursive: true,
  force: true
});

fs.mkdirSync(outputDir, { recursive: true });

const artists = new Map();
const groupSummary = [];

let songs = [];
let groupFileCount = 0;
let groupNumber = 0;
let totalSongs = 0;

function saveGroup() {
  if (songs.length === 0) return;

  groupNumber++;

  const filename =
    `songs-${String(groupNumber).padStart(3, "0")}.json`;

  writeJson(filename, songs);

  groupSummary.push({
    file: filename,
    source_files: groupFileCount,
    songs: songs.length
  });

  console.log(
    `Tersimpan ${filename}: ${groupFileCount} file JS, ${songs.length} lagu`
  );

  songs = [];
  groupFileCount = 0;
}

for (let i = 0; i < sourceFiles.length; i++) {
  const filename = sourceFiles[i];

  const source = fs
    .readFileSync(filename, "utf8")
    .replace(/^\uFEFF/, "");

  const data = extractSongs(
    source,
    path.basename(filename)
  );

  for (const [key, item] of Object.entries(data)) {
    if (!item || typeof item !== "object") continue;

    const id = String(item.id ?? key);
    const artistId = String(
      item.id_band ?? item.artist_id ?? ""
    );

    const artistName = String(
      item.nama_band ?? item.artist_name ?? ""
    ).trim();

    const title = String(
      item.judul ?? item.title ?? ""
    ).trim();

    const content = String(
      item.isi ?? item.content ?? ""
    );

    if (artistId || artistName) {
      const artistKey = artistId || slugify(artistName);

      if (!artists.has(artistKey)) {
        artists.set(artistKey, {
          id: artistId || artistKey,
          name: artistName,
          slug: slugify(artistName)
        });
      }
    }

    songs.push({
      id,
      artist_id: artistId,
      artist_name: artistName,
      title,
      slug: slugify(`${artistName} ${title}`),
      youtube_id: String(
        item.youtube_id ?? item.youtubeId ?? ""
      ),
      content,
      source_file: path.basename(filename)
    });

    totalSongs++;
  }

  groupFileCount++;

  if (groupFileCount >= GROUP_SIZE) {
    saveGroup();
  }

  if ((i + 1) % 25 === 0) {
    console.log(
      `Proses ${i + 1}/${sourceFiles.length} file JS`
    );
  }
}

saveGroup();

const artistList = [...artists.values()].sort(
  (a, b) => a.name.localeCompare(b.name, "id")
);

writeJson("artists.json", artistList);

writeJson("index.json", {
  generated_at: new Date().toISOString(),
  source_files: sourceFiles.length,
  total_songs: totalSongs,
  total_artists: artistList.length,
  group_size_source_files: GROUP_SIZE,
  files: groupSummary
});

console.log("Konversi selesai.");
console.log(`Jumlah file JS: ${sourceFiles.length}`);
console.log(`Jumlah lagu: ${totalSongs}`);
console.log(`Jumlah artis: ${artistList.length}`);
console.log(`Jumlah JSON lagu: ${groupNumber}`);

fs.rmSync(tempDir, {
  recursive: true,
  force: true
});
