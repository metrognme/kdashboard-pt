import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const volume = path.resolve(process.argv[2] || "/Volumes/Kindle");
const documentsDir = path.join(volume, "documents");
const proofLog = path.join(documentsDir, "kindle-dashboard-proof.log");
const nativeLog = path.join(documentsDir, "kindle-dashboard-native.log");
const diagnoseLog = path.join(documentsDir, "kindle-dashboard-diagnose.log");
const pgm = path.join(documentsDir, "kindle-dashboard-last-render.pgm");
const outDir = path.resolve("kindle/native/build");
const png = path.join(outDir, "kindle-dashboard-last-render.png");

function readIfPresent(file) {
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(volume)) fail(`Kindle nao encontrado em: ${volume}`);
if (!existsSync(pgm)) {
  fail([
    `Renderizacao salva nao encontrada: ${pgm}`,
    "Ejete o Kindle, rode uma atualizacao pelo KUAL (Painel Kindle) e conecte de novo."
  ].join("\n"));
}

const proofText = readIfPresent(proofLog);
const nativeText = readIfPresent(nativeLog);
const diagnoseText = readIfPresent(diagnoseLog);
const combined = [proofText, nativeText, diagnoseText].join("\n");

if (!/render=(framebuffer ok|fbink ok)/.test(combined)) {
  fail("O PGM existe, mas os logs nao comprovam que a renderizacao na tela funcionou.");
}

if (!/saved_pgm_bytes=|render=save-pgm /.test(combined)) {
  fail("Os logs nao mostram que o PGM foi gerado pelo programa do painel.");
}

mkdirSync(outDir, { recursive: true });
execFileSync("sips", ["-s", "format", "png", pgm, "--out", png], { stdio: "ignore" });

console.log(`Prova OK: ${pgm}`);
console.log(`PNG de previa: ${png}`);
