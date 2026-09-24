// Monta la demo en dist/demo/ a partir del código REAL de web/ más el simulador demo/mock.js.
//   dist/demo/index.html      portada de la demo (demo/landing.html)
//   dist/demo/app/            la web de verdad, con config.js sustituido por el simulador
// Uso: node scripts/build-demo.mjs
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "dist/demo");
const app = join(out, "app");

rmSync(out, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

cpSync(join(root, "web"), app, { recursive: true, filter: (src) => !src.endsWith("_headers") });
cpSync(join(root, "demo"), join(app, "demo"), {
  recursive: true,
  filter: (src) => !src.endsWith("mock.js") && !src.endsWith("landing.html"),
});
writeFileSync(join(app, "config.js"), readFileSync(join(root, "demo/mock.js")));
cpSync(join(root, "demo/landing.html"), join(out, "index.html"));

// La demo carga las librerías desde jsDelivr y las fuentes desde Google Fonts (versiones fijadas),
// en vez de llevar copias: así se puede publicar en sitios que solo admiten esos orígenes.
for (const dir of ["checkin/vendor", "demo/vendor", "assets/fonts"]) rmSync(join(app, dir), { recursive: true, force: true });
const FONTS = '@import url("https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800&family=Instrument+Sans:wght@400..700&display=swap");\n';
for (const css of ["assets/site.css", "checkin/checkin.css"]) {
  const p = join(app, css);
  writeFileSync(p, FONTS + readFileSync(p, "utf8").replace(/@font-face\s*\{[^}]*\}\s*/g, ""));
}
const landing = join(out, "index.html");
writeFileSync(landing, readFileSync(landing, "utf8")
  .replace(/@font-face\s*\{[^}]*\}\s*/g, "")
  .replace("<style>", '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800&family=Instrument+Sans:wght@400..700&display=swap">\n<style>'));

// Algunos alojamientos no resuelven "carpeta/" a "carpeta/index.html": se enlaza al archivo.
const rewrites = [
  [/src="(\.\.\/checkin\/|)vendor\/supabase-2\.117\.1\.js"/g, 'src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.1/dist/umd/supabase.js"'],
  [/src="vendor\/jsQR-1\.4\.0\.js"/g, 'src="https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js"'],
  [/src="vendor\/qrcode-generator-1\.4\.4\.js"/g, 'src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js"'],
  [/<link rel="preload" href="assets\/fonts\/[^"]+" as="font" type="font\/woff2" crossorigin>\n?\s*/g, ""],
  [/href="\.\/"/g, 'href="index.html"'],
  [/href="\.\.\/admin\/"/g, 'href="../admin/index.html"'],
  [/href="\.\.\/checkin\/"/g, 'href="../checkin/index.html"'],
];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if ([".html", ".js"].includes(extname(p))) {
      const before = readFileSync(p, "utf8");
      const after = rewrites.reduce((s, [re, to]) => s.replace(re, to), before);
      if (after !== before) writeFileSync(p, after);
    }
  }
}
walk(app);

const files = [];
(function list(dir, prefix = "") {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) list(p, `${prefix}${name}/`);
    else files.push(`${prefix}${name}`);
  }
})(out);
writeFileSync(join(root, "dist/demo-files.json"), JSON.stringify(files, null, 2));
console.log(`dist/demo: ${files.length} archivos`);
