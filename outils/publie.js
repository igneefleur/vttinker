/* PUBLIER : LES PAQUETS, LE SITE, ET LA BRANCHE DES PAGES.
 *
 *     node outils/publie.js            construit tout, et s'arrête là
 *     node outils/publie.js --pousse   ... puis pousse sur gh-pages
 *
 * ---------- DEUX BRANCHES, ET ELLES NE SE MÉLANGENT PAS ----------
 *
 * · « main »      porte la SOURCE : l'extension, le banc, le pilote, les pages
 *                 du site à l'état de markdown. Rien de construit.
 * · « gh-pages »  porte le RÉSULTAT : du HTML, deux archives, et rien d'autre.
 *                 Elle n'a pas d'histoire à raconter — elle est écrasée à
 *                 chaque publication.
 *
 * Un résultat de construction n'entre jamais dans une branche de source : il
 * grossit l'historique, il crée des conflits que personne ne sait lire, et il
 * finit par diverger de ce qui l'a produit.
 *
 * ---------- CE QUI EST REFUSÉ, ET POURQUOI ----------
 *
 * Sans le « .xpi » SIGNÉ, on ne publie pas. Une page de téléchargement dont le
 * bouton principal rend une erreur 404 est pire que pas de page : elle fait
 * croire que le produit existe et qu'il est cassé.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const RACINE = path.join(__dirname, "..");
const DIST = path.join(RACINE, "dist");
const PAGES = path.join(RACINE, "site");
const BATI = path.join(RACINE, ".site");
const POUSSE = process.argv.indexOf("--pousse") >= 0;

function git(args, opts) {
  return execFileSync("git", args, Object.assign({ cwd: RACINE, encoding: "utf8" }, opts || {}));
}

function mkdocs(args) {
  /* mkdocs est un exécutable Python, hors du PATH du shell qui nous lance. On
   * le cherche là où le poste l'a mis plutôt que d'espérer. */
  const candidats = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python313", "Scripts", "mkdocs.exe"),
    "mkdocs"
  ];
  for (const c of candidats) {
    try { return execFileSync(c, args, { cwd: RACINE, encoding: "utf8", stdio: "pipe" }); }
    catch (e) { if (e.code !== "ENOENT") { throw e; } }
  }
  throw new Error("mkdocs introuvable");
}

function main() {
  const m = JSON.parse(fs.readFileSync(path.join(RACINE, "extension", "manifest.json"), "utf8"));
  console.log("VTTinker " + m.version);

  /* ---------- 1. LES PAQUETS ---------- */
  console.log("\n  ---------- les paquets ----------");
  execFileSync(process.execPath, [path.join(__dirname, "paquet.js")], { cwd: RACINE, stdio: "inherit" });

  /* ---------- 2. CE QUE LA PAGE OFFRE AU TÉLÉCHARGEMENT ----------
   *
   * Des noms STABLES, sans numéro de version : l'adresse d'un téléchargement ne
   * doit pas changer à chaque publication, sinon tout lien partagé meurt. Le
   * numéro reste dans dist/, pour l'archive. */
  console.log("\n  ---------- ce que la page offre ----------");
  /* ON PREND CELUI DE LA VERSION QU'ON PUBLIE, ET PAS LE PREMIER VENU.
   *
   * Le tri était celui du répertoire, donc l'ordre alphabétique, donc
   * « …-0.51.0.xpi » AVANT « …-0.52.0.xpi ». dist/ garde toutes les signatures :
   * à la deuxième publication, la page aurait offert l'ANCIENNE extension à côté
   * du zip Chrome tout neuf — deux navigateurs, deux versions, et rien pour le
   * dire. Le nom du fichier porte le numéro ; on s'en sert. */
  const xpi = fs.existsSync(DIST)
    ? fs.readdirSync(DIST).filter(function (f) {
        return f.slice(-4) === ".xpi" && f.indexOf("-" + m.version + ".xpi") > 0;
      })
    : [];
  if (!xpi.length) {
    console.log("\n  AUCUN .xpi SIGNÉ EN " + m.version + " dans dist/.");
    console.log("");
    console.log("  On ne publie pas une page dont le bouton principal rend une erreur,");
    console.log("  ni une page qui offrirait une version que le reste ne porte pas.");
    console.log("  Signe d'abord :   node outils/signe.js");
    return 1;
  }
  fs.copyFileSync(path.join(DIST, xpi[0]), path.join(PAGES, "vttinker-firefox.xpi"));
  console.log("  site/vttinker-firefox.xpi   <- " + xpi[0]);

  const zip = "vttinker-" + m.version + "-chrome.zip";
  fs.copyFileSync(path.join(DIST, zip), path.join(PAGES, "vttinker-chrome.zip"));
  console.log("  site/vttinker-chrome.zip    <- " + zip);

  /* ---------- 3. LE SITE ----------
   *
   * « --strict » : un lien mort est une erreur, pas un avertissement. C'est
   * exactement le contrôle qui manquait au moment où l'on s'apprêtait à publier
   * deux boutons vers des fichiers absents. */
  console.log("\n  ---------- le site ----------");
  mkdocs(["build", "--strict"]);
  const n = (function compte(d) {
    return fs.readdirSync(d, { withFileTypes: true })
      .reduce(function (t, e) {
        return t + (e.isDirectory() ? compte(path.join(d, e.name)) : 1);
      }, 0);
  })(BATI);
  console.log("  .site/ : " + n + " fichiers");

  /* ---------- 4. LA BRANCHE DES PAGES ---------- */
  if (!POUSSE) {
    console.log("\n  Construit, et rien n'a été poussé.");
    console.log("  Pour regarder :   mkdocs serve");
    console.log("  Pour publier  :   node outils/publie.js --pousse");
    return 0;
  }

  console.log("\n  ---------- gh-pages ----------");
  const branche = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const sale = git(["status", "--porcelain"]).trim();
  if (sale) {
    console.log("  L'arbre de travail n'est pas propre. On ne publie pas un état");
    console.log("  qu'on ne saurait pas retrouver :");
    console.log(sale.split("\n").slice(0, 8).map(function (l) { return "    " + l; }).join("\n"));
    return 1;
  }

  /* « .nojekyll » : sans lui, GitHub Pages passe le site à Jekyll, qui IGNORE
   * tout dossier commençant par un souligné — et Material en produit un. */
  fs.writeFileSync(path.join(BATI, ".nojekyll"), "");

  /* On fabrique la branche dans un arbre de travail séparé : la branche courante
   * n'est jamais quittée, donc jamais laissée dans un état intermédiaire. */
  const TEMP = path.join(RACINE, ".gh-pages");
  fs.rmSync(TEMP, { recursive: true, force: true });
  try { git(["worktree", "remove", "--force", TEMP], { stdio: "pipe" }); } catch (e) {}
  let existe = true;
  try { git(["rev-parse", "--verify", "gh-pages"], { stdio: "pipe" }); }
  catch (e) { existe = false; }
  git(existe ? ["worktree", "add", TEMP, "gh-pages"]
             : ["worktree", "add", "--orphan", "-b", "gh-pages", TEMP], { stdio: "inherit" });

  fs.readdirSync(TEMP).forEach(function (f) {
    if (f === ".git") { return; }
    fs.rmSync(path.join(TEMP, f), { recursive: true, force: true });
  });
  (function copie(de, vers) {
    fs.mkdirSync(vers, { recursive: true });
    fs.readdirSync(de, { withFileTypes: true }).forEach(function (e) {
      const a = path.join(de, e.name), b = path.join(vers, e.name);
      if (e.isDirectory()) { copie(a, b); } else { fs.copyFileSync(a, b); }
    });
  })(BATI, TEMP);

  execFileSync("git", ["add", "-A"], { cwd: TEMP, stdio: "inherit" });
  const rien = execFileSync("git", ["status", "--porcelain"], { cwd: TEMP, encoding: "utf8" }).trim();
  if (!rien) {
    console.log("  Le site est déjà à jour : rien à publier.");
  } else {
    execFileSync("git", ["commit", "-m", "Site " + m.version], { cwd: TEMP, stdio: "inherit" });
    console.log("  gh-pages : commit fait. Pousse-le quand tu veux :");
    console.log("      git push origin gh-pages");
  }
  git(["worktree", "remove", "--force", TEMP]);
  console.log("\n  Tu es toujours sur « " + branche + " ».");
  return 0;
}

process.exit(main());
