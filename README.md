# VTTinker

Une extension navigateur qui retouche Roll20 : beaucoup de petites choses, et
quelques grandes. Chaque retouche est un **module**, qu'on allume et qu'on
éteint séparément depuis le panneau de l'extension.

Firefox d'abord, Chrome ensuite. Autonome : rien n'est chargé depuis un site,
tout est dans le paquet.

## Ce que l'extension coûte, et comment on le sait

Roll20 est déjà lourd, et beaucoup de gens y jouent sur une machine modeste. La
machine de référence n'est donc pas celle qui développe — et la règle qui en
découle est simple : **on ne « croit » pas qu'une chose coûte, on la pèse.**

| | mesuré |
|---|---|
| le shader de la grille | **0,07 ms par image** (fenêtres appariées, zoom 150) |
| une pose de grille | **5 ms** — dont lecture 1, périodes 0, ajustement 0, pose 1 |
| au repos, 20 s | **0 pose**, aucun compteur qui bouge |
| chemin de la molette | **0 balayage du document** pour 50 événements |
| surface d'injection | l'éditeur seul, cadre supérieur seul |

Trois pièges méthodologiques, tous rencontrés :

- **Le nombre d'images par seconde ne dit rien** : il est plafonné par la
  synchronisation verticale, et treize gels de cent millisecondes le font à peine
  bouger. On relève le TEMPS par image — médiane, p95, pire — et le *temps
  bloqué*, somme de ce que chaque image dépasse 50 ms.
- **Comparer deux sessions ne marche pas** pour un écart de l'ordre de la
  milliseconde : le temps par image dérive tout seul entre 5 et 11 ms. On
  alterne DANS la même session, par fenêtres de deux secondes.
- **Un instrument qui ment est pire que pas d'instrument.** Le chemin de cache
  de la pose renvoyait l'objet mémorisé tel quel, `ms` compris : le journal
  affichait « en 9 ms » pour un coup de cache gratuit. Corrigé avant de mesurer
  quoi que ce soit d'autre.

Et une optimisation **refusée par la mesure** : remplacer le grand quad troué par
un anneau de quatre quads autour de la page, pour ne plus rasteriser là où on
n'écrit rien. Gain réel : 0,07 ms par image. Risque : une couture entre les
quads, exactement le défaut qu'on a mis trois sessions à éliminer. Non.

## Vérifier avant de charger

```
node outils/verifie.js
```

Une extension ne se teste pas en la rechargeant vingt fois dans un navigateur en
regardant si « ça marche ». `outils/verifie.js` monte un **faux Roll20**,
construit d'après ce qui a été mesuré sur une vraie partie, et y fait tourner le
code réel — les deux mondes et le pont qui les relie. Il vérifie :

1. que le manifeste ne nomme aucun fichier absent, et qu'aucun fichier n'est
   orphelin (un fichier non déclaré est du poids mort, parfois une vieille
   version qu'on croit encore chargée) ;
2. que tous les `.js` passent l'analyse syntaxique ;
3. que le monde **isolé** démarre : catalogue lu, module déclaré, démarrage
   effectué, demande partie vers la page, couple de bornes invalide refusé ;
4. que le monde **principal** répond : bornes installées, zoom prolongé aux
   extrémités avec le bon pas, et tout rendu à Roll20 à l'extinction.

Le faux Roll20 reproduit exactement le relevé : `setZoom` borne à `[10, 250]`
puis appelle `setZoomSilent` ; `stepAdjustZoom` prend un booléen de sens,
arrondit aux dizaines et passe par `setZoom` ; la caméra suit la formule.

**`setZoomSilent` borne-t-il ?** On l'ignore — tous ses appelants bornent pour
lui, donc rien ne l'a jamais montré. Le banc joue donc **les deux modèles**, et
l'extension doit passer dans les deux. C'est la seule façon honnête de traiter
une inconnue qu'on ne peut pas lever.

Node n'est requis que pour ça : l'extension n'a aucune dépendance.

## Le pilote — Firefox conduit depuis la ligne de commande

Depuis la racine du dépôt (`cd` d'abord — les commandes sont relatives) :

```
npm install            # une fois
npm run connexion      # une fois : se connecter à Roll20 dans le profil dédié
npm run recon          # puis, autant qu'on veut
npm run zoom
npm run journal
node outils/pilote.js js "return d20 ? 'là' : 'absent'"
```

Roll20 n'est documenté nulle part : tout ce qu'on sait de lui a été relevé dans
la console d'une vraie partie, puis recopié à la main d'une fenêtre à l'autre.
C'était le vrai coût du projet. `outils/pilote.js` le supprime : Firefox se
lance seul, avec l'extension déjà posée en module temporaire, va sur la partie,
exécute ce qu'on veut, prend des captures d'écran et écrit tout dans
`outils/releves/`.

**Il n'utilise pas le Firefox de tous les jours ni son profil.** Il en tient un
à lui, dans `outils/.profil`, hors du suivi git. Rien de la navigation ordinaire
n'est lu, touché ni recopié.

**La connexion se fait dans un Firefox ordinaire, jamais dans le piloté.**
Roll20 protège sa page de connexion par un contrôle anti-robot, et un navigateur
conduit par geckodriver s'annonce comme tel : il pose `navigator.webdriver` et
ouvre Marionette. Le contrôle le voit — et il a raison de le voir. `connexion`
lance donc Firefox **sans aucune automatisation**, comme si on l'avait cliqué :
un humain se connecte, résout ce qu'il y a à résoudre, et les cookies restent
dans le profil. Le pilote ne fait ensuite que s'en servir ; il n'a plus jamais à
se connecter, donc plus jamais à passer devant ce contrôle.

`node outils/pilote.js zoom` est le pendant réel de `verifie.js` : le même
scénario, mais contre le vrai Roll20 au lieu d'un modèle. Le modèle dit que la
logique est juste ; celui-ci dit qu'elle l'est **chez eux**, ce qu'aucun modèle
ne peut promettre. Il remet le zoom de départ en dernier, quoi qu'il arrive.

Corollaire dans l'extension : `VTT.log()` ne se contente pas de la console, il
dépose aussi le journal **entier** sur `window.__vttinkerJournal`, dans le monde
de la page. Un script de contenu écrit sinon dans une console que rien
d'extérieur ne sait lire.

⚠️ `outils/.profil/` contient une **session Roll20 authentifiée**, et
`outils/releves/` des noms de joueurs et des identifiants de campagne : les deux
sont exclus de git, et doivent le rester.

## Charger l'extension pour l'essayer

**Firefox** — `about:debugging#/runtime/this-firefox` → « Charger un module
complémentaire temporaire… » → choisir `extension/manifest.json`. L'extension
disparaît à la fermeture de Firefox ; le bouton « Actualiser » recharge le code
après une modification.

**Chrome** — `chrome://extensions` → activer « Mode développeur » → « Charger
l'extension non empaquetée » → choisir le dossier `extension/`.

## Ce qu'il y a dedans

```
extension/
  manifest.json          MV3, sert Firefox et Chrome
  commun/catalogue.js    LA liste des modules — lue par le popup ET par la page
  ui/theme.css           la palette de la fiche D&D 2024, relevée sur Roll20
  popup/                 le panneau : il dessine le catalogue, il écrit le stockage
  contenu/
    000-socle.js         définitions seules ; n'agit pas
    modules/<id>.js      un fichier par module
    999-demarrage.js     le seul fichier qui agit : lit le stockage, lance
  page/pont.js           injecté dans le MONDE PRINCIPAL, là où vivent les
                         objets internes de Roll20
  icons/
outils/verifie.js        le banc d'essai contre un faux Roll20 (hors du paquet)
outils/pilote.js         Firefox conduit depuis la ligne de commande
```

**Le module ne fait rien tant que ses bornes valent celles de Roll20.** Allumé
par défaut sur 10–250, c'est-à-dire exactement ce que Roll20 fait déjà, il ne
remplace rien et n'intercepte rien : du risque pur pour zéro différence. La
partie ne bouge que quand une valeur change réellement.

### Les deux mondes

Un script de contenu partage le DOM de Roll20 mais **pas ses variables** : les
objets internes du site sont invisibles depuis là. Le seul passage sans `eval`
est une ressource déclarée en `web_accessible_resources`, chargée par une balise
`<script src>` — c'est ce que fait `VTT.injectePont()`. Le pont n'est injecté
qu'**à la demande d'un module**, jamais au chargement : un script poussé dans le
monde principal pendant que Roll20 se monte gêne son propre démarrage.

Les deux côtés se parlent par `postMessage` vers `window.top`, chacun répondant
par `ev.source` — ce qui traverse les origines sans avoir à connaître l'arbre
des frames.

### Ajouter un module

Trois gestes, pas un de plus :

1. une entrée dans `commun/catalogue.js` (identifiant, nom, résumé, réglages) ;
2. `contenu/modules/<id>.js`, qui appelle `VTT.module({ id, demarre })` ;
3. une ligne de plus dans `content_scripts[0].js` du manifeste.

Le panneau, le stockage, la validation et le cycle de vie suivent tout seuls.
Le catalogue est la source unique : pas de case à cocher qui ne commande plus
rien, pas de module allumé qu'aucune case ne montre.

**L'interrupteur d'un module marche dans les deux sens, à chaud.** Éteint, le
module est prévenu s'il sait l'être — il a peut-être laissé la page dans un état
dont elle ne sait plus sortir seule. Rallumé, il **redémarre sur-le-champ**. On
avait d'abord décidé le contraire, en attendant un rechargement de la partie :
c'était défendable pour un module qui aurait démonté la moitié de l'interface,
et faux pour tous les autres — éteindre puis rallumer faisait disparaître la
commande de zoom définitivement, sans que rien ne l'explique. Un module qui ne
sait pas redémarrer le déclare, par `relance: false` ; aucun ne le fait.

Corollaire pour qui écrit un module : **`demarre()` peut être appelé plusieurs
fois**. Les écouteurs se posent une fois et une seule — ce sont des fonctions
anonymes, `removeEventListener` n'a rien à leur passer.

### Permissions

`storage`, et rien d'autre. Le panneau n'envoie aucun message : il écrit le
stockage, et chaque onglet Roll20 ouvert écoute `storage.onChanged` et se met à
jour de lui-même. Joindre un onglet directement aurait demandé la permission
`tabs`, c'est-à-dire l'accès à l'historique de navigation.

## Modules

| Module | État |
|---|---|
| **Bornes du zoom** — remplace les bornes 10 % / 250 % de la table | fait et **vérifié sur une vraie partie** : boutons, molette, au-dessus comme en dessous. Deux réglages, un minimum et un maximum ; le reste se fait tout seul |
| **Grille hors carte** — prolonge la trame au-delà de la page | fait et vérifié : la case garde sa taille, les lignes restent alignées sur les siennes |
| **Marqueurs personnalisés** — des pictogrammes d'état à soi, en plus des siens | fait et vérifié sur une vraie partie : pose, retrait, images de domaines étrangers, alignement au pixel sur sa rangée |

## Marqueurs personnalisés

Roll20 n'accepte que ses propres pictogrammes d'état, et leur nombre est arrêté.
Ce module en ajoute d'autres, à partir d'une simple adresse d'image.

### Ce qui est écrit chez Roll20 se résume à l'étiquette

L'étiquette part dans `statusmarkers`, à côté des siennes, et **il l'ignore sans
un mot** — mesuré : une étiquette inconnue ne le dérange pas, et son propre menu
continue de fonctionner, sa fonction `toggleTokenMarker` travaillant en *delta*
et non par réécriture.

On ne touche donc **pas à son catalogue de marqueurs** — la seule chose qu'on
écrive à côté est le document de partage décrit plus bas, archivé et hors du
journal. Chez quelqu'un qui n'a pas l'extension, l'étiquette ne dessine rien, et
c'est tout ce qui se passe. C'est aussi ce qui fait que la **pose** se partage
toute seule : `statusmarkers` est une donnée de campagne comme les siennes, et
Roll20 la diffuse comme les siennes.

### L'étiquette porte son adresse — et supprime tout le reste

L'étiquette voyage jusqu'aux autres joueurs toute seule, mais l'ancienne forme
(`vt-poison`) ne disait que le **nom** : pour savoir quelle image dessiner, il
fallait un catalogue commun.

Il y en a eu un, et il a été **supprimé**. C'était un document de campagne à
créer, à lire, à fusionner sans écraser celui des autres, à faire converger par
un tri d'étiquettes pour que deux machines ne se répondent pas indéfiniment — et
que seul un MJ pouvait écrire.

La forme d'aujourd'hui se suffit à elle-même :

```
vttk_<nom>_<adresse sans https://>

vttk_poison_cdn.discordapp.com/emojis/1234567890123.webp?size=96
```

N'importe quel joueur ayant l'extension voit le marqueur, **immédiatement**, sans
rien avoir reçu de personne et sans le moindre droit d'écriture. Et plus rien
n'est écrit dans la campagne au-delà de l'étiquette elle-même — ce qui était le
but depuis le début.

**Mesuré avant d'y aller**, parce qu'un champ de campagne n'est pas un
presse-papier :

| | relevé |
|---|---|
| une étiquette de 70 caractères | écrite, relue, renvoyée **intacte** |
| quatre secondes plus tard | toujours intacte |
| trois marqueurs d'un coup (180 car.) | intacts |
| `?`, `=`, `/`, `.` | passent sans dommage |

Le découpage est **non ambigu** parce que le nom s'interdit le souligné : le
premier ferme le préfixe, le second ferme le nom, tout ce qui suit est l'adresse.
Le schéma est retiré parce qu'il est toujours le même — seul `https` est
accepté —, ce qui économise huit caractères par marqueur.

**Restent interdits la virgule et l'arobase**, et ce n'est plus un détail de
forme : Roll20 découpe ce champ sur les virgules et coupe après `@` pour y lire
un compteur. Une adresse qui en porterait couperait l'étiquette en deux et
fabriquerait des marqueurs fantômes. La validation les refuse, des deux côtés.

**On ne croit rien de ce qu'on lit.** Cette chaîne vient des données de la
campagne, donc d'autres joueurs, et le pont vit dans la page de Roll20 : le nom
doit avoir exactement la forme qu'on produit, l'adresse est revalidée
(`https` seul, hôte pointé, chemin, 240 caractères au plus), et une étiquette
illisible est simplement ignorée.

> **Un hôte plausible, pas seulement « ça commence par https:// ».** Le premier
> jet se contentait de « commence par `https://` et ne contient ni espace ni
> chevron » — et laissait donc passer `https://javascript:alert(1)`, qui n'est
> pas une adresse d'image mais coche toutes les cases. Inoffensif (Babylon
> échouerait à la charger), mais ça n'a rien à faire dans les données d'une
> campagne.

**Et l'ancienne forme n'est plus lue du tout.** Une compatibilité a existé
quelques heures, le temps de croire qu'il fallait ménager des marqueurs déjà
posés — mais l'extension n'a jamais eu d'utilisateur hors de son auteur : il n'y
avait rien à ménager, et deux formats, c'est deux chemins à tenir d'accord pour
rien. Une étiquette qui ne se relit pas entièrement — préfixe, nom, adresse — est
un marqueur inconnu, que ni Roll20 ni nous ne dessinons.

Le panneau garde un bouton **« copier pour partager »** — utile pour transmettre
sa palette à quelqu'un, non plus pour qu'il *voie* vos poses (l'étiquette y
suffit) mais pour qu'il puisse *reposer* les mêmes marqueurs.

### La géométrie, mesurée et non déduite

Tout ce qui suit vient d'un relevé sur une vraie partie (`node outils/pilote.js
place`, `pas`, `qui`, `etat`, `fond`), pas d'une lecture de son code :

| | relevé |
|---|---|
| repère | monde = (`left`, −`top`) — aucun décalage |
| ancre | un nœud `<id>-markers` **par token**, y compris ceux qui ne portent aucun marqueur |
| position de l'ancre | le coin **haut-droit** du token : (`left` + `width`/2 ; −(`top` − `height`/2)) |
| profondeur de l'ancre | celle du token lui-même |
| taille d'un pictogramme | **19 × 19** unités — indépendant de la taille du token (mesuré sur 70 et 140) et du zoom |
| pas d'un pictogramme au suivant | **22**, vers la gauche ; la rangée est alignée à droite |
| centre du dernier | (−12,5 ; −12,5) dans le repère de l'ancre |

D'où le placement des nôtres, qui continuent sa rangée :

```
x = -12,5 - (nombre de pictogrammes de Roll20 + rang) × 22
```

Un décompte faux des **siens** les ferait chevaucher — c'est le défaut que le
banc surveille avec un token qui porte les deux à la fois.

### Le nœud survit, et c'est ce qui rend le module gratuit

Roll20 **détruit et recrée** ses propres quads à chaque changement, de marqueurs
comme de position. Mais le nœud `<id>-markers`, lui, **garde son identité** — et
les enfants qu'on lui ajoute restent accrochés. Vérifié : un quad à nous a
traversé deux reconstructions de la rangée et un déplacement de 70 unités, qu'il
a suivi au centième.

Conséquence directe : **aucun écouteur de position, aucun recalcul par image,
aucun guet.** On pose des quads une fois, et c'est la transformation de Roll20
qui les promène. Le seul abonnement est `change:statusmarkers`, et traîner un
token ne le réveille même pas.

Le corollaire, contre-intuitif : nos quads ne sont **pas** `freezeWorldMatrix`,
là où le quad de la grille l'est. C'est en recalculant sa matrice depuis son
parent qu'un quad suit son token. Le banc vérifie les deux, en sens opposés.

### Un matériau par image, jamais un par quad

Recréer un matériau, c'est recompiler un programme GLSL — la leçon a été payée
sur la grille, où sept poses en quatre secondes recompilaient sept fois le même
shader. Deux tokens portant le même marqueur partagent donc le **même** matériau et
la même texture. Et comme tous nos matériaux partagent le même source GLSL,
Babylon ne compile qu'**un seul programme** quel que soit le nombre de marqueurs.

Le shader tient en dix lignes : une image, sa transparence, et un `discard` franc
sur les pixels transparents — une émote l'est sur la plus grande partie de son
carré. Pas d'éclairage, pas de brouillard, pas de couleur : autant d'instructions
par pixel qu'un `StandardMaterial` aurait posées pour rien.

### L'orientation, et le témoin qui mentait

Une image a son origine en haut à gauche, une texture WebGL en bas à gauche :
sans `invertY`, elle sort **à l'envers**. C'est là que ça se règle — sur la
texture, pas dans le nuanceur.

Ça n'a pas été trouvé du premier coup, et l'erreur vaut d'être écrite. Le premier
jet passait `invertY: false` *et* retournait l'UV en x, sur la foi d'une
comparaison côte à côte avec le pictogramme `lightning-helix`. Or **un éclair en
Z a une symétrie de demi-tour** : pour lui, miroir horizontal et miroir vertical
rendent la *même* image. Le témoin ne pouvait donc pas distinguer les deux
fautes. Le vrai défaut était vertical, la « correction » horizontale, et leur
composition donnait un demi-tour — soit un marqueur à l'envers, que l'épreuve
déclarait bon et qu'un utilisateur a vu tout de suite.

> **Un témoin d'orientation doit n'avoir aucune symétrie** — ni miroir, ni
> demi-tour. On emploie `snail` et `spanner`, et on en dessine **deux** : un
> témoin unique qui se révélerait symétrique ferait retomber dans le même piège.

### Devant le token, et pas à sa hauteur

Roll20 pose ses pictogrammes à `z = 0` sous le nœud, donc à la profondeur
**exacte** du token, et s'en tire par un `zOffset` sur son matériau. Les nôtres,
à la même profondeur mais sans cette ruse, passaient **derrière** l'image du
token — et comme la rangée est à l'intérieur du token, ils y disparaissaient.

La caméra est en `z = 0` et regarde vers les *z* croissants : plus petit veut
dire plus près. On avance donc nos quads de **100 unités**. C'est assez pour
passer devant à coup sûr — la profondeur est linéaire sur seize millions
d'unités, une seule ne pèserait qu'un cran du tampon — et bien assez peu pour
rester dans le créneau du token, que Roll20 espace de 500. Un token posé
*par-dessus* continue donc de couvrir nos marqueurs, exactement comme il couvre les
siens.

L'épreuve se fait sur un **petit** token, dont l'œuvre remplit toute la case :
sur un token à marges transparentes, un marqueur qui paraît « devant » ne prouve
rien, puisqu'il n'a peut-être rien devant quoi passer.

### Fusionner avec SON système : ce qui est possible, et ce qui ne l'est pas

La question mérite d'être posée — un cadre en plus dans une interface qui en a
déjà beaucoup, c'est un cadre de trop. Voici ce qui a été **mesuré**, et non
supposé.

| | mesuré |
|---|---|
| ajouter nos marqueurs à `Campaign.attributes.token_markers` **après** le chargement | il ne les dessine **pas** |
| les y ajouter **avant** que la scène soit montée, catalogue déjà peuplé | il ne les dessine **toujours pas** |
| son propre choix de marqueurs dans le DOM | **absent** — 5656 nœuds balayés, aucun ne référence une de ses images |
| sa sélection de tokens (`d20.engine.tabletopSelected`) | reste **vide** sous un clic de pilote comme sous des événements de pointeur dispatchés |
| sa colonne d'outils | **du vrai DOM** — `#master-toolbar > .upper-buttons > .toolbar-button-outer` |

Ses pictogrammes sont échantillonnés dans un **atlas de 4096 × 4096** qui arrive
déjà cuit : le client ne le construit pas à partir des adresses du catalogue. Le
seul chemin vers son moteur de rendu passerait donc par son propre téléversement
d'images sur ses serveurs. **Le dessin reste à nous.**

> La première version de ce paragraphe affirmait que son menu de marqueurs est
> dessiné dans le canevas. C'était vrai, mais ce n'était pas *établi* : la
> conclusion venait d'un clic qui, en réalité, n'avait rien sélectionné. La
> mesure ci-dessus l'a vérifié pour de bon.

### L'interface, elle, est la sienne

Le rendu nous revient, mais rien n'oblige à poser un cadre pour autant. On entre
donc dans **sa colonne d'outils**, exactement comme la commande de zoom entre
dans sa colonne de zoom : on ne dessine pas un bouton, on **clone le sien**.

Sa colonne est découpée en sections, chacune ouverte par un intitulé — `Outils`,
`Effets`. L'extension ouvre la sienne, **VTTK**, sous les siennes, et y range
**deux** boutons : les réglages et les marqueurs.

```
div.spacer-outer[role=separator]
  div.spacer-inner      le filet
  div.spacer-header     le mot
```

Là encore rien n'est dessiné : le filet, la casse, l'espacement et le thème
viennent de lui. Il faut seulement prendre garde à cloner un séparateur **qui
porte un mot** — la colonne en contient aussi des nus, et cloner celui-là
donnerait un filet sans titre.

### Les glyphes, mesurés un par un

Le bouton cloné garde son `span.grimoire__roll20-icon`, dont le **texte est le
nom du glyphe**. Lesquels existent ne se devine pas : un nom inconnu s'affiche en
toutes lettres. On a donc mesuré — en clonant un vrai span d'icône et en
comparant la largeur rendue à celle d'un glyphe connu.

| | |
|---|---|
| **existent** | `star`, `starFilled`, `heart`, `heartFilled`, `wandSparkle`, `user`, `userCircle`, `plus`, `settings`, `message`, `checkCircle`, `infoCircle`, `helpCircle`, `starOutline`, `heartOutline`, `pill` |
| **n'existent pas** | `emoji`, `emote`, `sticker`, `smiley`, `badge`, `tag`, `status`, `condition`, `marker`, `token`, `flag`, `skull`, `shield`, `bell`, `gear`, `cog`, `wrench`… |

D'où `settings` pour les réglages. Pour les marqueurs, en revanche, **rien à lui
emprunter** : ni `smiley`, ni `smile`, ni `faceSmile`, ni `emoji`, ni `emote`, ni
`sticker`. Le bouton porte donc un sourire **dessiné**, en SVG, à `currentColor`
pour suivre son thème — et **plein**, comme ses icônes à lui : les yeux et la
bouche sont évidés par la règle `evenodd`, sans rien peindre dans la couleur du
fond, qu'on ne connaît pas. Un tracé au trait, essayé d'abord, pesait
visiblement moins que le rouage et la baguette voisins.

> **Deux détours avant d'y arriver.** Le premier jet mettait l'image du premier
> marqueur sur le bouton, faute de savoir ce que la police contenait — mais un
> bouton d'outil qui change d'aspect selon la palette n'est pas un bouton
> d'outil. Le deuxième prenait `starFilled`, faute de sourire : approchant, pas
> juste.

### L'ordre dans la section est FIXE

Chaque pièce à nous porte un **rang** (`data-vttk-rang`) et s'insère avant la
première des nôtres qui a un rang supérieur : l'intitulé, puis le rouage, puis
les modules. Sans ça l'ordre était celui de la **création** — le bouton des
réglages se pose depuis un guet au chargement du pont, celui des marqueurs quand le
module s'installe, et lequel arrive d'abord dépend du moment où sa colonne est
peinte. On voyait donc le rouage sous les marqueurs une fois sur deux.

### Les réglages s'ouvrent d'ici, plus de l'icône du navigateur

Le bouton `settings` ouvre le panneau de l'extension **dans la page**, à côté de
la colonne. Ce n'est pas une seconde interface : c'est la **même page** —
`popup/popup.html` — chargée dans un cadre. Une seule définition de ce que
l'extension propose, donc jamais deux qui divergent, et rien à tenir en double.

La page est déclarée accessible depuis la page hôte dans le manifeste, pour le
**seul éditeur de Roll20**. Son adresse est reconstruite depuis celle du pont
(`document.currentScript.src`, lu à la seule seconde où il vaut quelque chose) :
l'identifiant d'installation change à chaque fois, et la page n'a aucun accès à
`browser.runtime`.

Le cadre est d'une **autre origine** — `moz-extension://` contre
`app.roll20.net` — donc la page ne peut pas lire dedans. C'est la bonne
isolation, et c'est aussi pourquoi l'épreuve y entre par WebDriver plutôt que par
`contentDocument`, qui rend `null`.

### Collé à la boîte à outils, même hauteur

La géométrie est celle du **plateau de narration de l'extension JJK**, reprise
telle quelle — c'est là qu'elle a été mise au point :

```
x = barre.right      collé, zéro pixel entre les deux, et pas un seul DESSOUS
y = barre.top        le même haut, pour que les deux forment un bloc
h = barre.height     EXACTEMENT sa hauteur
```

Ne pas glisser sous la barre est un choix, pas un oubli : un chevauchement ferait
passer ses outils derrière notre panneau. Le creux du coin se règle par un
arrondi — le bord gauche, lui, reste droit puisqu'il touche la barre.

> **Le premier jet alignait le panneau sur le BOUTON**, qui est en bas de la
> colonne : le panneau s'ouvrait donc en bas de la page, et il fallait aller
> l'y chercher. C'est précisément ce que cette géométrie-là évite.

La position et la hauteur sont posées **en ligne** par le pont, qui mesure la
barre : le CSS ne sait ni où elle commence ni jusqu'où elle descend.

L'icône du navigateur continue d'ouvrir le même panneau : elle ne coûte rien et
reste le seul chemin hors d'une partie.

### Les couleurs se lisent chez lui, elles ne sont plus écrites ici

Le premier jet posait un décor sombre en dur — fond `#171717`, bord `#816e54`.
Il allait en thème sombre et détonnait en clair. Or son interface est **blanche**
par défaut : mesuré, `#master-toolbar` a un fond `rgb(255,255,255)` et un texte
`rgb(51,51,51)`.

Et son thème ne se **devine** pas davantage :

> Son bascule `colorTheme` a été actionné pour de bon — le magasin passe de
> `light` à `dark` — et **aucune** de ses variables CSS ne change, ni le fond de
> sa barre. Ces variables-là (`--panel-bg: #171717`, `--text-color: #e6e6e6`)
> sont celles de la **fiche de personnage**, pas de l'interface du plateau.

La seule vérité est donc ce que son interface **rend**. Le pont lit la couleur de
sa barre et de son texte, en déduit le mode par la **luminance** du fond, et
repose les deux sur nos boîtes — sur nos boîtes, jamais sur `:root`. Le panneau,
lui, reçoit le mode par le fragment de son adresse (`popup.html#clair` ou
`#sombre`), seul moyen de parler à un cadre d'une autre origine sans échanger de
messages.

`ui/theme.css` porte donc deux palettes. La sombre est **relevée** sur une vraie
fiche D&D 2024 ; la claire est **dérivée** — Roll20 n'en expose aucune
équivalente — à partir des trois seules valeurs sûres que son interface rend, en
gardant l'accent rouge de la fiche, qui fait reconnaître l'extension d'un thème à
l'autre.

Le clone garde toutes ses classes, ses attributs de portée Vue et son thème ; on
ne lui impose que l'image qui remplace le glyphe — celle du premier marqueur de la
palette, qui dit mieux qu'un pictogramme deviné ce que le bouton ouvre. Sa police
d'icônes n'a d'ailleurs rien qui évoque une émote, et un nom de glyphe inconnu
s'afficherait en toutes lettres.

> **On clone un bouton qui se voit.** Le premier jet prenait le *dernier* de la
> colonne — c'est celui du débordement, masqué. Le clone héritait de sa taille
> nulle : invisible à l'écran, mais bien présent dans les relevés. Le banc
> vérifie désormais que le modèle cloné a une hauteur.

L'intitulé et le bouton se posent **avant** ce bouton de débordement, qui ferme
la colonne et reste masqué tant qu'elle tient en hauteur : se poser après lui
marcherait aujourd'hui et se verrait le jour où il apparaît.

La palette est un **tiroir** qui sort de ce bouton et n'existe que quand on
l'ouvre. Faute de colonne où se greffer — une version de Roll20 qui l'aurait
renommée —, elle retombe sur une palette flottante : un module qui ne trouve pas
sa boîte ne doit pas disparaître en silence.

### La palette porte DEUX familles

| | dessiné par | vu par |
|---|---|---|
| **Vos marqueurs** | nous | ceux qui ont l'extension |
| **Marqueurs de Roll20** — 63 pictogrammes, 7 pastilles, 1 croix | **lui** | **tout le monde** |

Les siens valent d'être là : les poser par notre chemin est plus rapide que par
son menu, et comme c'est **lui** qui les dessine, ils restent visibles de tous,
extension ou pas. Ils s'affichent **huit par ligne**, comme dans sa fenêtre.

### Même taille que les siens, et on passe à la ligne

Roll20 rapetisse ses marqueurs dès que la rangée dépasserait la largeur du token.
Les nôtres ne le faisaient pas et sortaient du cadre. Deux règles, dans cet
ordre :

1. **la taille est la sienne** — on la *lit* sur ses propres quads, on ne la
   choisit pas ;
2. **quand la ligne est pleine, on passe à celle du dessous**, à la même taille.
   On ne rapetisse pas pour faire tenir : ce qui est déjà petit deviendrait
   illisible.

Sa loi, relevée échelle par échelle de 1 à 14 marqueurs sur un token de 140 puis
de 70, sert de **repli** quand il n'a rien dessiné :

```
échelle = (largeur du token − 1,5) / (22 × nombre)
```

À moins de 1 % près de ses valeurs : pour 5 marqueurs sur un token de 70 il prend
0,62 et la formule donne 0,6227 ; pour 14, 0,22 contre 0,2224. Mais on préfère
**lire** que calculer : sa loi est quantifiée par pas de 0,02 d'une façon qu'on
ne reproduit qu'approximativement, et 1 % d'écart entre deux marqueurs côte à
côte se voit.

> **Il ne compte que ce qu'il dessine.** Mesuré : ajouter cinq marqueurs à nous
> ne change **pas** son échelle. Il garde donc les siens à sa taille, et le
> débordement nous revient — d'où le passage à la ligne plutôt qu'un
> rapetissement que lui n'appliquerait pas.

### La ligne est une invention de notre côté

**Roll20 n'a pas de lignes.** Il n'en connaît qu'une, et il rapetisse jusqu'à
tout y faire tenir, quel que soit le nombre. Le passage à la ligne n'existe que
chez nous.

Sa capacité est le **plus grand** de deux nombres : ce qu'il a dessiné, et ce qui
tient à l'échelle courante. Son nombre comme son échelle sont **lus sur ses
quads** — pas déduits de nos étiquettes, qui supposeraient qu'il dessine tout ce
qu'on croit.

> **Le calcul seul se trompait.** La capacité valait `floor(largeur / pas)`. À
> onze marqueurs sur un token de 140 Roll20 prend 0,58, ce qui fait une rangée de
> **140,36 pour 140** : il déborde. La formule en comptait dix par ligne, lui en
> mettait onze — notre douzième case partait en colonne 1 de la seconde ligne,
> avec un **trou à sa droite**. Signalé par une capture d'écran.

> **Et le constat seul se trompait aussi.** La règle est alors devenue « autant de
> cases que sa rangée en porte à cet instant ». Or son compte ne mesure la
> capacité **que lorsqu'il a rapetissé**, c'est-à-dire lorsque sa rangée est
> pleine. À taille pleine il ne mesure rien : avec **un seul** marqueur à lui,
> notre ligne portait **une** case, et nos marqueurs descendaient en colonne le
> long du bord droit — sur un token de 70, le quatrième sortait par le bas.
>
> Le banc le montrait sans qu'on le voie : `dead`, qui n'occupe aucune case,
> laissait notre marqueur **en haut**, tandis que `skull` le faisait descendre de
> deux lignes. Ajouter un marqueur à Roll20 déplaçait les nôtres du coin
> haut-droit vers une colonne verticale.
>
> Les deux lectures sont vraies chacune dans son domaine, et le **maximum** les
> réunit sans exception : quand il a rapetissé, son compte l'emporte ; quand il
> est à taille pleine, c'est le calcul.

Vérifié sur une vraie partie, à 0, 3, 9, 11 et 13 marqueurs de Roll20 : mêmes
tailles, positions sur sa grille au centième, rien qui déborde de notre fait. À
onze, ses quads sont en `(-7,25 … -134,85 ; -7,25)×11,02` et les nôtres en
`(-7,25 … -58,29 ; -20,01)×11,02` — la ligne du dessous, alignée à droite, sans
trou.

### Qui occupe une case, et qui n'en occupe pas

Nos marqueurs se rangent **à la suite** des siens : on compte les siens, on se
décale d'autant. Un décompte faux les fait **chevaucher**. Deux cas ne se
devinaient pas, et tous deux ont été mesurés :

| | occupe une case ? | conséquence de l'erreur |
|---|---|---|
| **pastilles de couleur** | **oui** (`red` en −34,5, `blue` en −12,5) | non comptées → notre marqueur **par-dessus** la dernière |
| **`dead`** | **non** — il barre tout le token | compté → une case **vide** entre les siens et les nôtres |

> **Les deux erreurs se compensaient** quand un token portait une pastille *et*
> un `dead` — d'où un défaut qui n'apparaissait qu'« à certains moments ». C'est
> le genre de chose qu'un banc ne tient que s'il éprouve les deux séparément :
> il le fait maintenant.

### On dit « marqueur », pas « jeton »

Dans l'interface **française** de Roll20, un « jeton » est un **token** — sa
colonne de calques l'affiche ainsi. Employer le même mot pour ce qu'on pose
*dessus* entretenait une confusion que rien ne justifiait. Tout ce qui se lit
dit donc « marqueur ».

**Et les identifiants ont suivi.** Ils avaient d'abord été laissés en l'état —
renommer une clé de stockage n'en migre pas le contenu, elle l'oublie — mais
l'extension n'a encore aucun utilisateur hors de son auteur, et la cohérence des
noms vaut mieux qu'une compatibilité avec personne. Ont donc changé :

| avant | après |
|---|---|
| `commun/jetons.js`, `contenu/modules/jetons.js` | `…/marqueurs.js` |
| `reg:jetonsPerso`, `mod:jetons`, `_avis:jetons` | `reg:marqueursPerso`, `mod:marqueurs`, `_avis:marqueurs` |
| `jetons`, `jetons-ajoute`, `jetons-retire`, `jetons-bilan` (messages) | `marqueurs-…` |
| `.vttk-jeton-*`, `.vttk-barre-jeton`, `.jetons-*` | `.vttk-marqueur-*`, `.vttk-barre-marqueur`, `.marqueurs-*` |
| `vttJeton*`, `JETON_*`, `jetonsMiens`, `poseJetonsSur`… | `vttMarqueur*`, `MARQUEUR_*`, `marqueursMiens`, `poseMarqueursSur`… |

Le préfixe d'étiquette `vttk_`, lui, ne contenait pas le mot : il n'a pas bougé,
et les marqueurs déjà posés restent lisibles.

> **L'ordre des remplacements était le seul vrai danger.** `jetons-ajout` (une
> classe CSS) est un préfixe strict de `jetons-ajoute` (un type de message) :
> traiter le court d'abord aurait emporté le second en silence, et rompu le bus
> sans une ligne de journal. Le renommage va donc du plus long au plus court, et
> refuse de tourner sur un motif qui ne trouve rien — un motif mort signale que
> quelque chose a déjà bougé sous lui.

Neuf occurrences de « jeton » subsistent, et c'est voulu : elles désignent les
**tokens** de Roll20, ou expliquent précisément cette distinction.

### Trois sources, et deux d'entre elles n'étaient pas les bonnes

**`tokenMarkerData`, et non `token_markers`.** Le premier jet lisait
`Campaign.attributes.token_markers` — 47 entrées, et il en manquait seize. Le
magasin Pinia `campaign` en porte **63** sous `tokenMarkerData` : les mêmes, plus
celles que la **fiche de personnage** ajoute (`sheet-blinded`, `sheet-charmed`,
`sheet-deafened`…, servies depuis `beacon-sheets/tokenmarkers/`). C'est de là que
sa propre fenêtre tire sa liste.

**Les sept pastilles de couleur ne sont dans aucun catalogue.** Elles vivent
comme **maillages**, sous les noms `red-marker-template`, `blue-marker-template`…
Elles n'ont donc pas d'image — ce sont des disques vectoriels, qu'il faut
dessiner. Leurs teintes sont **lues sur ses propres modèles** (`diffuseColor`),
et relevées ici comme repli :

| | | | |
|---|---|---|---|
| `red` `rgb(201,16,16)` | `blue` `rgb(16,118,201)` | `green` `rgb(47,201,16)` | `brown` `rgb(201,115,16)` |
| `purple` `rgb(149,16,201)` | `pink` `rgb(235,117,225)` | `yellow` `rgb(229,235,117)` | |

**La croix rouge non plus.** C'est le marqueur `dead`, rendu par un maillage
`deadmarker` à part. Elle se range avec les pastilles, comme dans sa fenêtre.

Qu'elles s'appliquent bien comme étiquettes a été **vérifié** : un premier essai
avec `set()` n'avait rien donné, mais `set()` ne redessine pas, ce qui ne
prouvait rien. Par `save()`, Roll20 les dessine.

> **Aucun compte n'aurait montré ce qui manquait.** 47 entrées, ça ressemble à
> une liste complète. C'est la comparaison à l'écran avec sa propre fenêtre qui
> a fait apparaître les seize de la fiche, les sept pastilles et la croix — et
> c'est l'utilisateur qui l'a faite.

### C'est la palette qui gère, plus le panneau

L'ajout et la suppression étaient dans les réglages ; ils sont **dans la
palette**, parce que c'est là qu'on s'en sert — à côté des marqueurs de Roll20 et
du token qu'on vise. Les avoir aux deux endroits, ce serait deux formulaires à
tenir d'accord, et le jour où ils divergent personne ne sait plus lequel dit
vrai. Le panneau n'en garde que l'interrupteur, la liste en lecture et le bouton
« copier pour partager ».

**Mais la validation n'est pas dans la palette.** Le pont vit dans la page : il
n'a ni `browser.storage`, ni le modèle de `commun/marqueurs.js`. Il envoie donc ce
qu'on a saisi **tel quel** au script de contenu, qui l'analyse avec le modèle
partagé, écrit le stockage, et renvoie son compte rendu. Une seule définition de
ce qu'est un marqueur valide, où que le geste parte.

### Deux pastilles, deux coins, deux choses

Une seule pastille portait le nombre frappé au clavier **quand il y en avait un**,
et sinon le rang du clic. Les deux ne pouvaient donc jamais paraître ensemble, et
rien ne distinguait « ce marqueur portera un 3 » de « ce marqueur est le
troisième choisi » — même place, même forme.

| | où | couleur |
|---|---|---|
| le **nombre** appliqué au marqueur | en bas à **gauche** | rouge cerné de blanc, comme le compteur que Roll20 dessine sur les siens |
| le **rang** dans la sélection | en bas à **droite** | rose, comme tout ce qui appartient à l'extension |

> **Et elles tiennent DANS la tuile.** Elles débordaient de deux pixels de chaque
> côté pour un écart de quatre entre tuiles : le rang d'une tuile venait toucher
> le nombre de sa voisine, et les deux se lisaient comme un seul chiffre à
> rallonge. Rentrées, l'écart des tuiles les sépare tout seul.

### La palette est écartée de la boîte à outils ET du plafond, comme les siennes

Nos panneaux étaient **collés** au bord droit de sa colonne, puis — une fois cela
corrigé — collés au **plafond**. Les siens ne le sont ni l’un ni l’autre :
`.block-submenu`, le panneau que Roll20 fait sortir de cette même colonne, est
posé à `left: 60px` **et** `top: 24px`, pour une colonne large de 44 dont le haut
est à 0. Mesuré sur une vraie partie, sur le même témoin.

| | jour |
|---|---|
| à gauche de la colonne | **16 px** |
| sous le plafond | **24 px** |

On ne choisit donc pas ces valeurs, on les recopie : une fenêtre qui touche ce
que les siennes n’atteignent pas se voit tout de suite, et les deux fois ça a été
signalé.

> **Le jour du bas est le même que celui du haut.** Roll20 ne donne pas la
> réponse — ses panneaux sont taillés sur leur contenu et ne descendent pas
> jusqu’en bas —, mais une fenêtre écartée en haut et collée en bas serait
> bancale. La hauteur maximale perd donc les deux jours.

### Le rouage, au troisième essai

Il en a fallu trois, et les deux ratés valent d'être écrits :

1. une **couronne pleine** décrite par un long tracé de courbes écrit à la main.
   Rendue à quatorze pixels, elle donnait une **tache** dont on ne distinguait
   plus les dents ;
2. un **cercle et huit rayons** tracés au trait. Lisible, mais ce n'était plus un
   rouage : les rayons partant *hors* du cercle, ça se lisait « soleil » ou
   « astérisque » — et c'est ce qui a été signalé.

Un rouage se reconnaît à une **silhouette dentée pleine, percée en son milieu**.
Elle est **calculée** : huit dents carrées, chacune un créneau entre le rayon
extérieur et le rayon de fond, et un moyeu évidé par la règle pair-impair. Une
liste de coordonnées écrite à la main se relit mal et se corrige encore plus mal —
c'est exactement ce qui a produit la tache du premier jet.

### La palette ne se referme plus toute seule

**Un clic ailleurs la fermait.** C'est l'usage d'un menu, mais elle n'en est pas
un : on y revient sans cesse pendant qu'on travaille sur la carte, et chaque
aller-retour coûtait un clic de rouverture.

Elle se ferme désormais de **deux façons, et de deux seulement** : le bouton de
la boîte à outils — qui bascule —, et sa **croix**, en haut à droite de sa barre
de titre, là où toute fenêtre porte la sienne.

**Échap n'en est pas une troisième.** Il vide la sélection de marqueurs, et rien
de plus : c'est une touche qu'on frappe sans y penser, et la même sert à annuler
tout et n'importe quoi dans Roll20.

> **Il y a donc un écouteur de moins**, en capture sur toute la page, pendant tout
> le temps où la palette est ouverte. Ce n'est pas un renoncement, c'est un gain :
> un écouteur de clic en capture se paie à *chaque* clic.

### Le rouage : deux modes, et un seul bouton

Hors édition, la palette ne fait **qu'une** chose — choisir des marqueurs et les
poser. Rien n'y est cliquable par erreur. Le rouage, en haut à droite, révèle
ensemble les trois gestes qui modifient la palette :

- le formulaire **`[Nom] [Adresse] [+]`**, sur une ligne. Ce qu'il y avait avant
  demandait de connaître une syntaxe — `Nom | url` dans une zone de texte — pour
  faire la chose la plus simple du module. Le nom reste facultatif : sans lui, on
  le tire de l'adresse.
- les **croix de suppression**. Quarante-sept croix affichées en permanence sur
  des tuiles de vingt-huit pixels, c'est un accident qui attend son heure.
- le **tri à la souris**. La tuile traînée prend la place de la cible ; venant
  d'avant elle se pose après, venant d'après elle se pose avant.

Le transfert de glissement porte un type à nous — `application/x-vttk-marqueur` —
et rien d'autre : Roll20 accepte des dépôts sur son plateau, et un `text/plain`
qui lui échapperait pourrait lui parler. Avec un type qu'il ne connaît pas, un
dépôt hors de notre grille ne fait rien, chez lui comme chez nous.

**L'ordre est réconcilié par le script de contenu, pas imposé par la page.** Le
pont envoie l'ordre voulu ; le modèle commun met les étiquettes citées en tête et
laisse le reste à la suite. Une demande venue d'une palette périmée — un marqueur
supprimé entre-temps par une autre fenêtre — ne peut donc ni ressusciter ni
effacer quoi que ce soit.

### Poser plusieurs marqueurs d'un coup

Le pointage se fait tout seul, avec ce qu'on a déjà : la caméra, et le rectangle
de chaque token — des données de la page, pas des détails d'implémentation. On
choisit **autant de marqueurs qu'on veut** dans la palette, on clique un token,
ils s'y posent tous. La sélection survit à la pose, pour marquer plusieurs tokens
de suite.

**La règle tient en une phrase**, et un seul marqueur choisi n'en est que le cas
dégénéré — la bascule d'avant :

> On **ajoute**, sans doublon, dès qu'au moins un des marqueurs choisis manque.
> On **retire** tous les marqueurs choisis s'ils sont tous déjà là.

Elle demande deux identités, et c'est son préalable, pas une exception :

| | jugé sur |
|---|---|
| **« est-il déjà là ? »** | ce qu'on **pose** — nu, la base suffit ; numéroté, le texte exact |
| **« est-ce un doublon ? »** | toujours la **base** |

> **Le doublon a été un vrai défaut**, et il n'existait que dans le chemin à
> plusieurs. En comparant les *textes*, `skull@7` ne satisfaisait pas `skull` : sur
> un token qui portait déjà `skull@7`, choisir skull *et* un marqueur absent
> écrivait `skull@7,skull,…`. Roll20 dessinait skull deux fois, sa rangée comptait
> une case de trop, et comme notre première case se déduit de la sienne, **tous**
> nos marqueurs se décalaient.

**Ce qu'on n'a pas choisi ne bouge pas** — y compris les étiquettes que personne
ne dessine. Un module qui « range » le champ d'un autre efface son travail.

**Une sélection vide n'est pas une pose**, et surtout pas un rangement : le
quantificateur piège, « tous les choisis sont là » étant vrai sur l'ensemble
vide. Rien n'est écrit, pas même une normalisation du champ.

**Échap défait un cran à la fois** : d'abord la sélection — toute la sélection, on
ne dépile pas —, puis le tiroir. Un clic hors de tout token annule sans refermer ;
le clic d'après referme.

**Rien n'écoute quand le tiroir est fermé.** Deux écouteurs en tout, et pas un de
plus : le tiroir en pose un (le clic ailleurs), la sélection en pose un second (le
clic sur le plateau) — un seul, quel que soit le nombre de marqueurs choisis. Un
écouteur de clic en capture sur toute la page se paie à *chaque* clic ; ceux-ci ne
coûtent que pendant les secondes où ils servent. Le banc les compte, un par un.

> **Le rendez-vous battait pour rien, et c'est ce qui coûtait le plus cher.** Le
> balayage complet arme un délai de 700 ms tant qu'un token attend son nœud
> Babylon. Mais `poseMarqueursSur` rendait `false` **aussi** pour « déjà à
> jour » : chaque token porteur d'un de nos marqueurs, parfaitement dessiné et
> parfaitement stable, comptait pour une attente. Le délai rappelait le balayage,
> qui recomptait la même attente — **un parcours complet de la page toutes les
> sept dixièmes de seconde, à vie**, dès qu'un seul marqueur était posé quelque
> part. Le cas de réessai rend désormais `null`, et lui seul.
>
> Ce battement réparait par accident un autre défaut : la **largeur** du token
> décide de la capacité d'une ligne, et elle n'était ni dans la signature ni
> écoutée. Redimensionner un token ne refaisait donc sa rangée que parce que le
> balayage repassait. Les deux sont réparés ensemble — et le banc ne pouvait pas
> voir le second, son faux modèle Backbone n'émettant `change:` que pour
> `statusmarkers`. Il les émet maintenant pour chaque attribut, comme le vrai.

### Deux manières de poser, et une seule règle

La palette porte un sélecteur à deux moitiés, en haut, hors du mode édition :
ce n'est pas un réglage mais une **façon de s'en servir**, qu'on change en cours
de partie selon ce qu'on a à faire.

| | geste | quand c'est le bon |
|---|---|---|
| **Marqueur → tokens** | on arme un marqueur, puis on clique les tokens | le **même** marqueur sur plusieurs tokens dispersés |
| **Tokens → marqueur** | on sélectionne des tokens *avec la sélection de Roll20*, puis un clic sur un marqueur les marque tous | **plusieurs** marqueurs sur les mêmes tokens |

**La règle est la même dans les deux modes, et la décision est COLLECTIVE :**

> Si **tous** les tokens visés ont le marqueur, on le retire à **tous**.
> Sinon on l'ajoute à **tous ceux qui ne l'ont pas**.

Un seul token n'en est que le cas dégénéré — « tous » vaut « lui » —, et on
retrouve exactement la bascule du premier mode. C'est pourquoi les deux modes
passent par la même fonction, et pourquoi aucun cas déjà éprouvé ne change de
réponse selon le mode.

> **Chaque token était jugé sur son propre champ, et c'était le défaut.** De deux
> tokens sélectionnés dont un seul portait le marqueur, le premier le perdait
> pendant que le second le gagnait : les deux se croisaient sans jamais se
> rejoindre, et cliquer deux fois ne faisait qu'**échanger leurs états**. On
> regarde donc l'ensemble d'abord, on décide une fois, et on applique.

La décision se prend sur les tokens qu'on peut **écrire**, et sur eux seuls : un
token d'autrui, qu'on ne pourra pas toucher, n'a pas à faire pencher la décision
pour les autres.

> **`tabletopSelected` est une FONCTION, et c'est ce qui avait été mal lu.** Un
> relevé ancien la prenait pour un tableau, la trouvait vide, et concluait que la
> sélection de Roll20 était inatteignable — d'où le pointage qu'on fait
> nous-mêmes dans l'autre mode. Elle délègue à
> `VTTEngine.instance.tabletop.getSelection()`, et chaque entrée porte `id` et
> `model`. Mesuré sur une vraie partie, et vérifié d'un clic **piloté** : un
> événement de confiance sélectionne là où un événement fabriqué dans la page
> échouait.

On la lit **au moment du clic**, jamais avant : rien à surveiller, rien à
mémoriser, donc rien qui puisse vieillir.

**Ce mode n'arme aucun écouteur de plateau** — il n'y attend aucun clic sur la
carte. Le chiffre au survol y garde tout son sens : il fixe le compteur que la
pose emportera, et il ne sert **qu'une fois**.

**Le mode est enregistré** (`reg:marqueursMode`) et voyage **avec le catalogue**,
pas dans un message à part : sans quoi il y aurait un instant où la palette
afficherait un mode et en appliquerait un autre.

**Et il rend compte** : « 2 tokens marqués », « 1 refusé : pas à vous », ou
« Sélectionnez d'abord un ou plusieurs tokens ». Un clic sans sélection ne ferait
rien du tout, et rien ne dirait pourquoi — c'est le défaut le plus facile à
commettre ici, parce que la palette a l'air de fonctionner.

### MJ ou joueur : qui a le droit d'écrire quoi

**Roll20 ne laisse écrire un token qu'à qui le contrôle.** Un joueur qui posait un
marqueur sur le token d'un autre voyait le marqueur **paraître** — Backbone met le
modèle à jour localement — puis **disparaître** quand le serveur reprenait la
valeur. Rien n'expliquait pourquoi, et la pose était invisible pour tout le
monde, lui compris.

Mesuré sur la **même partie ouverte deux fois**, en MJ et en joueur :

| | MJ | joueur |
|---|---|---|
| `window.is_gm` | `true` | `false` |
| tokens « contrôlés » | **0** | 3 |
| `activePage()` = page des joueurs | non | oui |
| calques visibles | `map` + `objects` | `objects` seul |
| boutons dans sa colonne | 20 | 11 |

> **Et le piège est le MJ.** Le `controlledby` de ses tokens est **vide** : une
> règle qui ne regarderait que ce champ lui interdirait de marquer ses propres
> tokens, c'est-à-dire tous. Le drapeau passe donc avant.

La règle, dans cet ordre : **MJ → tout** ; sinon `controlledby` contient `all` ou
mon identifiant de joueur. Le refus est **explicite** — la palette le dit en
rouge, et le script de contenu le journalise —, parce qu'un refus muet passe pour
une panne.

> **Drapeau inconnu : on autorise.** Si Roll20 renommait `is_gm`, refuser par
> défaut retirerait la fonction à tous les MJ. Autoriser laisse au pire un joueur
> devant un marqueur qui s'efface : désagréable, partiel, réversible. On ne
> choisit pas la panne la plus grave par prudence.

**Tout le reste tient en joueur**, vérifié sur une vraie partie : la section VTTK
et ses deux boutons, la palette et ses 72 tuiles, le rouage et son mode édition,
la pose sur ses propres tokens (qui **tient** six secondes plus tard), le
compteur, la grille étendue, le zoom au-delà de 250 et le panneau des réglages.

### Le chiffre au survol, et le compteur qu'il dessine

On survole une tuile, on frappe un chiffre : le marqueur est choisi **et**
numéroté. C'est le geste de Roll20 sur ses propres marqueurs, et il n'y avait
aucune raison qu'il s'arrête aux siens.

Les chiffres **s'enchaînent** tant qu'on reste sur la même tuile — `1` puis `2`
donnent douze, et non deux —, jusqu'à trois, ce que Roll20 accepte (`@999` se
dessine). Changer de tuile, ou une seconde de silence, et le nombre repart. `0`
seul efface. La touche est **arrêtée** : Roll20 a ses propres raccourcis.

Le survol passe par **un seul** écouteur, posé sur la barre, et non un par tuile :
soixante-dix tuiles, un enregistrement, et une palette reconstruite à chaque
ajout.

**Roll20 ne dessine le compteur que pour SES étiquettes** — les nôtres lui sont
inconnues. Le nôtre est donc recopié sur le sien, et tout est mesuré sur une
vraie partie :

| | relevé |
|---|---|
| texture | 28 px de haut ; 20 px de large pour un chiffre, **+16 par chiffre** |
| maillage | exactement la **moitié** de sa texture en unités de plateau — 2 px par unité |
| échelle | celle du marqueur, exactement (0,580 relevé pour une échelle de 0,58) |
| place | même abscisse que son marqueur, centre **7 × échelle** dessous |
| dessin | nombre **rouge pur** cerné de **blanc pur**, 26 des 28 px de haut |

> **`dead` n'a pas droit à un compteur, et c'est mesuré.** On a posé
> `red@4,dead@2,skull@9,blue@7` sur un vrai token : Roll20 a fabriqué un porteur
> de nombre pour red, blue et skull — **aucun** pour dead, qui n'est pas un
> pictogramme de rangée mais une croix barrant tout le token. Écrire `dead@2`
> serait une donnée que personne ne dessine. La frappe choisit quand même le
> marqueur ; elle ne lui accroche aucun nombre.
>
> **Les pastilles de couleur, elles, y ont droit** — c'était la vraie question, et
> la mesure a répondu l'inverse de ce qu'on soupçonnait.

### Pourquoi pas les emotes Discord automatiquement

C'était la demande de départ : connexion au compte, et on récupère les emotes de
ses serveurs. Recherché, et **non** :

- aucune portée OAuth ne donne les emojis d'une guilde à une application tierce ;
- les conditions d'utilisation de Discord interdisent explicitement de récolter
  « by using any robot, spider, crawler, scraper, or other automatic device,
  process, or software », ce qu'un script de contenu lisant sa page serait ;
- aucune extension existante ne le fait par le DOM — les outils de masse volent
  le marqueur du compte, ce qui est autrement plus grave ;
- Discord a banni Spy.pet pour de la récolte pourtant en lecture seule ;
- et le texte sanctionne qui « encourage or help others to breach », ce qui
  exposerait l'auteur autant que l'utilisateur.

Un champ de collage, donc. Les adresses `cdn.discordapp.com` fonctionnent
parfaitement — la politique de sécurité de Roll20 les accepte en `<img>`, en
`crossOrigin` et en texture Babylon, c'est mesuré. Seul le geste est manuel.

### Ce qui est refusé à la saisie

`http:` (contenu mixte : le marqueur serait invisible, et introuvable), `data:` (ne
se partage pas raisonnablement), et tout ce qui n'est pas une adresse `https`.
Les **noms** sont réduits à `[a-z0-9-]` — ni virgule, ni arobase, ni souligné —
et les **adresses** s'interdisent les deux premiers : l'étiquette entière traverse
un champ que Roll20 découpe sur les virgules et dont il coupe la partie après
`@` pour y lire un compteur. Le souligné, lui, sépare le nom de l'adresse.

Une adresse d'emote Discord n'a pour nom de fichier qu'un identifiant : on
l'appelle alors `e<identifiant>`, ce qui donne une étiquette **stable** —
recoller la même adresse demain rend la même — plutôt que de rejeter l'usage même
pour lequel le module existe.

## Destinataire du chat

Roll20 ne dit à qui l'on parle que par une **commande tapée à la main** :
`/w gm` pour le MJ, `/w Nom` pour un joueur. Il faut la connaître, la réécrire à
chaque message, et l'orthographier juste — un nom mal tapé part **en clair devant
toute la table**.

Son intitulé « En tant que : » devient **« De : »**, une seconde ligne s'ajoute
dessous, et son bouton d'envoi **remonte** à côté d'elle :

    De : [ igneefleur (GM) ▾ ]   [+] [☺] [GIF]
    À :  [ MJ              ▾ ]   [   Envoyer   ]

Les deux intitulés ont la même largeur, les deux sélecteurs aussi : les quatre
colonnes s'alignent d'elles-mêmes. Les trois boutons à droite n'ouvrent encore
rien — ils sont **désactivés**, parce qu'un bouton qui ne fait rien quand on le
presse est pire qu'un bouton absent.

> **Son bouton d'envoi est DÉPLACÉ, pas recréé** : un nœud déplacé garde ses
> écouteurs, un nœud cloné les perd, et c'est Roll20 qui les a posés. D'où il
> vient est noté sur le nœud, pour l'y remettre à l'extinction.
>
> **Il se désigne par son identifiant, `#chatSendBtn`.** Un premier jet visait
> « le bouton de la zone de chat », ce qui attrapait aussi les trois qu'on venait
> d'ajouter : chaque passage du guet en déplaçait un dans notre ligne, les trois
> y ont fini un par un, et le vrai n'a jamais bougé.

Le préfixe se met **tout seul** à l'envoi. Le destinataire choisi se **voit** —
l'intitulé passe en rose et le sélecteur se cerne — parce que la différence entre
un message que toute la table lit et un message privé ne doit pas dépendre d'un
menu déroulant refermé.

### Où vivent les joueurs

**Les entrées portent les noms, et rien d'autre.** Un premier jet écrivait
« MJ — chuchoter » et « Nom — hors ligne » : ni l'un ni l'autre n'avait été
demandé. Le premier répète ce que la ligne « À : » dit déjà ; le second est un
état qui change tout seul et sans conséquence — Roll20 délivre un chuchotement à
qui se reconnecte. Un menu qui commente ses propres entrées les rend plus longues
à lire, pas plus claires.

**Et vous y figurez.** Se chuchoter à soi-même est un usage : c'est ainsi qu'on se
garde une note dans le fil de la partie sans que la table la lise.

`Campaign.players.models`, dans le monde de la page — hors de portée du script de
contenu. Chaque entrée porte `displayname`, `online` et `color`. C'est le pont qui
les lit et les pousse ; il **écoute** ensuite la collection (`add`, `remove`,
`change:displayname`, `change:online`) plutôt que de la relire à intervalles.

**Le module, lui, ne touche à rien de Babylon** : la zone de chat est du DOM
ordinaire, et un script de contenu y a accès directement. Le pont n'apporte que
ce que le monde isolé ne peut pas voir.

> **La collection n'est pas là tout de suite**, et c'est ce qui a raté au premier
> jet : le module démarre avec la page, `Campaign.players` est alors absente, on
> envoyait donc une liste vide — et faute de collection à écouter, plus rien ne
> la corrigeait. Le sélecteur ne proposait que « tout le monde » et « MJ », pour
> toujours, sur une table de cinq joueurs.
>
> **Et le premier message partait dans le vide.** `injectePont` est asynchrone :
> la demande envoyée juste après se perdait. C'est le même guet que celui du
> module des marqueurs, et pour exactement la même raison.

### La syntaxe du chuchotement, mesurée

Quatre envois sur une vraie partie, chacun relu dans le journal du chat :

| envoyé | reçu |
|---|---|
| `/w gm texte` | « (To GM) : texte » |
| `/w Alandush texte` | « (To Alandush) : texte » |
| `/w Jean Batiste-Bernard … texte` | **cassé** — « (To Jean …) : Batiste-Bernard de la Boutonnière texte » |
| `/w "Jean Batiste-Bernard …" texte` | « (To Jean …) : texte » |

Sans guillemets, Roll20 devine bien le destinataire mais **avale une partie du
message** : il ne prend que le premier mot comme nom, et le reste retombe dans le
corps. D'où la règle — un nom qui n'est pas un seul mot simple passe entre
guillemets ; `gm` est un mot-clé, jamais un nom, donc jamais entre guillemets.

### Ce à quoi le sélecteur ne touche pas

**Une commande part telle quelle.** Un message qui commence par `/` en est une —
`/roll`, `/em`, `/desc`, `/gmroll`, ou un `/w` écrit à la main. Y coller un préfixe
la casserait, et il n'existe aucune façon générale de composer deux commandes de
Roll20. Vérifié : `/roll 1d20` reste un jet public même avec « MJ » choisi.

**Le destinataire ne s'enregistre pas.** C'est un état de travail, pas une
préférence : le retrouver au rechargement ferait chuchoter sans le savoir à
quelqu'un choisi la veille. Il retombe sur « tout le monde », le seul défaut sûr —
un message public envoyé par erreur se voit et se corrige, un message privé
envoyé au mauvais destinataire, non.

### La mise en page, et ce qu'elle a coûté

Deux lignes, **deux grilles identiques** — intitulé de largeur fixe, sélecteur
élastique, colonne de droite de largeur fixe :

```
De :  [ personnage   ▾ ]   [ + ] [ ☺ ] [ GIF ]
À  :  [ destinataire ▾ ]   [    Envoyer      ]
```

Les deux intitulés font la même largeur, les deux sélecteurs aussi, et le bouton
d'envoi occupe **toute** sa colonne — il ne reste pas un bouton posé dans un coin
là où le voisin du dessus en tient trois.

> **Deux largeurs sont forcées en `!important`**, celle des sélecteurs et celle
> du champ de saisie, et c'est une exception assumée. Les règles de Roll20 sont
> servies par `cdn.roll20.net` : la page ne peut pas les lire — énumérer
> `document.styleSheets` lève une erreur de sécurité sur celles-là —, donc pas
> davantage les surpasser en spécificité, faute de savoir ce qu'elles pèsent.
> Sans cette forçe, son sélecteur restait à 140 px dans une colonne de 210, et le
> champ finissait douze pixels plus étroit que les lignes du dessous.

### Deux pixels qu'aucune marge n'expliquait

Signalé ensuite : « sur la même ligne on voit "À" et "Envoyer" qui sont mal
alignés ». La feuille disait pourtant déjà l'inverse — même grille, `align-items:
center` —, ce qui est exactement le moment où il faut **mesurer chaque enfant**
plutôt que relire la règle. Écart de centres relevé : **4,5 px**, sur les deux
lignes. Deux causes empilées, et aucune des deux n'est ce qu'on cherche d'abord.

**La première est une marge héritée.** Les deux sélecteurs portent
`margin: 0 15px 9px 0` — celle de Roll20, venue avec ses classes. Or « centrer »
centre la **boîte de marge** : un contrôle de 26 px suivi de 9 px de marge basse
occupe une rangée de 35, et son cadre visible tombe 4,5 px **au-dessus** du
centre, pendant que le bouton d'envoi et les trois outils, sans marge, tombent au
vrai centre. Les 9 px du bas gonflaient en outre chaque rangée de 26 à 35 —
dix-huit pixels pris au journal pour rien.

**La seconde est un décalage de position, et c'est le pire cas.** Marges annulées,
il restait 2 px. Rien dans les marges, rien dans les paddings, rien dans les
bordures, hauteurs égales, rangée juste. La cause : `position: relative ; top:
-2px` sur les intitulés, posé par Roll20.

> **Un décalage relatif est invisible pour la grille.** Il laisse la boîte à sa
> place dans la mise en page — `align-items: center` la voit donc parfaitement
> centrée — et ne déplace que le dessin. Aucune règle d'alignement ne peut le
> voir, aucune marge ne peut le compenser, et il ne se trouve qu'en relevant
> `top` explicitement. `position: static` l'annule d'un coup, quel que soit le
> côté employé ; `top: 0` n'aurait rien fait s'il s'était servi de `bottom`.

**Et `display: flex` ne prend pas sur ces intitulés** : leur `display: block`
vient d'une règle de Roll20 portant un identifiant, imbattable en spécificité
depuis des classes. Un interligne égal à la hauteur du contrôle centre le texte
aussi bien, sans forcer quoi que ce soit.

Après correction, écart de centres : **0 px** sur les deux lignes.

### L'écart, et l'arbre qu'on n'avait pas lu

Annuler la marge du sélecteur a **collé les deux lignes l'une à l'autre** — zéro
pixel entre elles, mesuré. La zone porte pourtant bien un écart. Il ne les atteint
simplement jamais :

```
#textchat-input  (flex, colonne, écart 3px)
  ├─ textarea
  ├─ span, div.clear            ← hauteur nulle
  └─ div                        ← SANS CLASSE, display: block, écart « normal »
       ├─ .vttk-chat-de-ligne
       └─ .vttk-chat-a
```

Nos deux lignes ne sont pas filles de la zone mais d'un conteneur intermédiaire
qui n'espace rien. Roll20 les séparait par la marge basse de son sélecteur — la
même qui cassait l'alignement, donc celle qu'il fallait retirer. Une seule pièce
faisait les deux travaux, et elle en faisait un mal.

On marque donc ce conteneur d'une classe, comme les autres nœuds qu'on habille,
et l'écart se porte là où il agit. Une seule valeur pour tout — champ vers ligne,
ligne vers ligne, intitulé vers sélecteur, sélecteur vers boutons : **six pixels
partout**. Les trois outils restent plus serrés entre eux (quatre), sans quoi ils
ne se lisent plus comme un groupe.

**Le défaut signalé n'était pas celui qu'on croyait.** « Le tout est trop large,
ça change la taille de la zone de texte au-dessus » : mesuré des deux côtés, avec
le module puis sans lui, la **largeur est identique** — 341 px de panneau dans
les deux cas. C'est la **hauteur** qui avait bougé.

| | sans le module | premier jet | resserré | aligné | espacé |
|---|---|---|---|---|---|
| zone de saisie | 107 | 166 | 139 | 121 | **127** |
| journal du chat | 918 | 859 | 886 | 904 | **898** |

Le journal perd exactement ce que la zone prend. Une ligne de plus coûte sa
hauteur, et rien ne peut la rendre ; tout le reste est revenu au journal — d'abord
trente-deux pixels d'aération trop généreuse, puis les dix-huit que les marges
héritées des sélecteurs ajoutaient aux deux rangées. Le coût final de la ligne
« À : » est de **vingt pixels**, moins que sa propre hauteur — six d'entre eux
étant l'espacement qu'on lui rend après l'avoir supprimé par erreur.

### Ce qu'on lui rend

L'intitulé d'origine est gardé **sur le nœud** (`data-vttk-avant`) : l'extinction
le rend tel qu'on l'a trouvé, et une variable de module n'aurait pas survécu à un
rechargement de la zone par Roll20.

> **`parentNode` n'est pas un test de vie**, et l'avoir cru a coûté la capacité
> d'envoyer un message. Un sous-arbre détaché garde ses parents : notre ligne
> retirée du document répondait donc « je suis toujours en place », le guet ne
> reposait rien, et le vrai bouton d'envoi que Roll20 venait de recréer était
> déplacé dans un nœud que plus personne n'affichait. `document.contains` répond
> à la seule question qui compte — est-ce encore à l'écran.

> **Un module éteint ne remonte rien.** Les écouteurs de messages ne se retirent
> jamais ; celui qui reçoit la liste des joueurs rebâtissait donc tout l'habillage
> si un message était en vol au moment de l'extinction — sur un module qui n'est
> plus dans la liste des démarrés, donc sans aucun interrupteur pour l'enlever.
> Un drapeau tombe en première ligne de `arrete`, avant même de prévenir le pont.

### Les émojis

Le bouton à l'émoticône ouvre un choix de **697 émojis**. Un clic l'insère **au
curseur** — pas à la fin —, en remplaçant la sélection s'il y en a une,
exactement comme le ferait une frappe au clavier. Les derniers choisis reviennent
dans un onglet « Récents ».

**Ce qui part est du texte, et c'est toute la feature.** Un émoji Unicode voyage
dans le message comme une lettre : Roll20 le stocke, le rediffuse, et chaque
poste le dessine avec sa propre police. Un lecteur sans l'extension le voit donc
exactement comme nous — ce qui était la demande, et ce qui écarte d'emblée l'idée
d'émojis maison : une image servie par nous n'existerait que chez nous, et le
message arriverait troué chez les autres.

#### Les catégories sont celles d'Unicode

Le premier jet les avait **improvisées**, avec une catégorie « À la table » qui
n'existe dans aucune norme et qui piochait dans **sept** groupes officiels à la
fois. C'était défendable — le dé et le dragon servent plus qu'un taxi sur
Roll20 — mais c'était un classement de plus à apprendre, et un seul le
connaissait.

Ce sont désormais les **huit groupes d'UTS #51**, dans l'ordre du fichier, et
chaque émoji est dans le sien : les cœurs chez « Visages et émotions » (ce sont
des émotions), la météo chez « Voyage et lieux », les enseignes de cartes chez
« Activités ». Le catalogue est **engendré** depuis `emoji-test.txt` ; seuls les
noms français sont écrits à la main.

| onglet | groupe officiel | émojis |
|---|---|---|
| 😀 Visages et émotions | Smileys & Emotion | 121 |
| 👋 Gens et gestes | People & Body | 73 |
| 🐻 Animaux et nature | Animals & Nature | 78 |
| 🍔 Nourriture et boissons | Food & Drink | 89 |
| ✈️ Voyage et lieux | Travel & Places | 79 |
| ⚽ Activités | Activities | 79 |
| 💡 Objets | Objects | 117 |
| 🔣 Symboles | Symbols | 61 |

**« Flags » est le seul groupe absent**, et c'est la première règle qui l'exclut,
pas un oubli : un drapeau est une paire d'indicateurs régionaux, donc une
séquence composée.

#### Trois règles, vérifiées contre la source

La table officielle est gardée telle quelle dans `outils/`, avec sa notice. Elle
porte pour chaque émoji son **groupe**, sa **version d'apparition** et son état de
**qualification** — c'est elle que le banc d'essai interroge, plus la mémoire.

**Aucune séquence composée.** Un émoji d'ici tient en un caractère, plus au
besoin son sélecteur de présentation. Sont donc exclus les assemblages reliés par
U+200D, les teintes de peau et les drapeaux. Ce sont eux qui se décomposent sur
un poste en retard : au lieu d'un dessin, le lecteur reçoit deux ou trois dessins
à la suite, et le message dit autre chose que ce qu'on a écrit. Un caractère
simple ne peut pas se décomposer : au pire il manque, il ne ment pas.

**Rien de plus récent qu'Unicode 12** (2019). Six ans de recul, et on est lu
partout. Le banc lit la version réelle de chaque caractère ; le plafond de code
posé dans l'extension n'est qu'un garde-fou grossier, pour ce qui remonte du
stockage sans que la table soit là.

**Le sélecteur de présentation où il faut — et il n'y a pas de règle simple pour
savoir où.**

> **Le premier jet en avait inventé une** : « sous U+1F000, U+FE0F obligatoire ;
> au-dessus, interdit ». Elle est fausse dans les deux sens, et le contrôle l'a
> montré sur **soixante-treize entrées**. ⚡ ✨ ☕ ⛪ ✋ vivent sous le seuil et sont
> des émojis de naissance ; 🗡️ 🏔️ 🕷️ 🗺️ vivent au-dessus et sont des symboles
> typographiques, qui sans sélecteur se dessinent en noir et blanc à la taille
> d'une lettre. Ce n'est pas une affaire d'intervalle mais une propriété par
> caractère, et la connaître de mémoire est exactement le genre de chose sur quoi
> on se trompe.

La table le dit sans qu'on ait rien à déduire — un caractère mal composé y est
« minimally-qualified » — et le pilote **peint les 697 émojis** dans un vrai
navigateur pour voir ce qui sort : rien du tout, le carré vide de référence, ou
une image en gris. Relevé : **697 en couleur, 0 invisible, 0 carré vide, 0 en
gris**.

Et la promesse se vérifie jusqu'au bout : la sonde envoie « 🎲⚔️🐉 » et le relit
**dans le journal du chat**, intact. Ce qui est dans le journal, toute la table
le voit.

#### Le panneau se cale sur le champ

**Il flotte au-dessus du champ de saisie, à sa largeur exacte.** Le premier jet
l'ancrait au bouton qui l'ouvre : il **recouvrait** le champ, si bien qu'on ne
voyait plus ce qu'on écrivait au moment même où l'on y insérait quelque chose.

Il est posé sur `<body>`, en position fixe — la barre latérale de Roll20 découpe
ce qui dépasse, et un panneau posé dans le pied de chat se ferait rogner à
l'endroit exact où il devient utile. Il n'hérite donc plus des couleurs de la
zone, et le module lui porte à l'ouverture la couleur de texte et le fond relevés
sur elle, ce qui le fait suivre un thème sombre sans qu'on ait à le connaître.

**La largeur ne se devine pas, elle se mesure à chaque fois.** La zone de chat
est redimensionnable ; une largeur relevée à l'ouverture serait fausse au premier
glissement. Un `ResizeObserver` suit donc le champ tant que le panneau est
ouvert — un événement de fenêtre n'aurait rien vu passer.

> **Il a fallu deux essais ratés pour trouver la bonne poignée.** Le premier
> élargissait la barre latérale : elle n'a pas bougé d'un pixel, 330 avant comme
> après. Le second posait une hauteur en ligne sur le champ — relevé,
> `style.height = 118.4px` pour une hauteur calculée de **48,4** : le champ n'est
> pas redimensionnable par lui-même ici (`resize: none`, une règle de Roll20
> qu'on ne peut ni lire ni battre), et dans une colonne flexible un élément se
> fait de toute façon écraser à la taille de son conteneur. Ce qui est
> redimensionnable, c'est **la zone**, par la poignée que Roll20 pose sur son bord
> haut : elle passe de 127 à 242, et le champ de 48 à 163.
>
> **Une vérification qui ne fait pas varier ce qu'elle mesure ne vérifie rien**,
> et les deux premières n'ont vérifié que leur propre satisfaction.

Deux détails qui ne se voient que quand ils manquent : le panneau **refuse le
focus** (`mousedown` annulé à sa racine), sans quoi le curseur du champ —
c'est-à-dire l'endroit où l'émoji doit aller — serait perdu au premier clic ; et
un **seul écouteur** sert les 697 tuiles, au lieu de 697 fonctions à poser puis à
abandonner à chaque ouverture.

> **Une capture peut mentir.** La première photo du panneau le montrait vide —
> cadre, séparateur et trait de l'onglet courant, mais ni émoji ni titre — alors
> que la mesure prise juste avant comptait huit onglets et cinquante-deux tuiles,
> toutes visibles, en gris foncé sur blanc. Rien n'était cassé :
> `getBoundingClientRect` force la mise en page, pas le dessin, et la capture est
> partie entre les deux. Une sonde qui photographie ce que le navigateur n'a pas
> encore peint accuse le code de ce dont le chronomètre est responsable.

## Les deux surfaces

Il y en avait une, comptée deux fois : la fenêtre de l'extension et le panneau
de la boîte à outils étaient **le même fichier**, `popup/popup.html`, chargé une
fois dans la fenêtre du navigateur et une fois dans une iframe posée sur la
partie. Deux endroits pour un seul geste, et aucun des deux n'était le bon.

La séparation est celle-ci :

| | ce qu'on y fait |
|---|---|
| **la fenêtre du navigateur** | si l'extension **existe**, et dans quelle langue elle parle |
| **le panneau, dans la partie** | ce qu'elle **fait** — quel module, quels réglages |

La fenêtre tient en quatre choses : un interrupteur général, un choix de langue,
la version, et deux boutons — site et soutien — **préparés et désactivés**, parce
qu'un bouton qui ne fait rien quand on le presse est pire qu'un bouton absent.
Leur infobulle le dit.

### Le style est relevé chez lui, pas imité

« Respecte les normes de Roll20 », « du style à la Roll20 », « le texte est trop
grand ». On n'y répond pas de mémoire : chaque valeur vient d'un relevé sur ses
propres panneaux, une vraie partie ouverte.

| | valeur relevée |
|---|---|
| police | Proxima Nova |
| taille dominante | **13 px** — 1591 nœuds sur 2823 |
| titre de panneau | 16 px, Proxima Nova Condensed, gras 600 |
| texte | `#625b65` — fort : `#29212e` |
| panneau | fond blanc, **rayon 10 px**, en-tête `12px 12px 0 0` |
| ombre | `0 6px 10px rgba(0,0,0,.14), 0 1px 18px rgba(0,0,0,.12)` |
| bouton | rayon 4 px |
| accent | **`#e10085`** |

> **L'accent était faux partout.** On employait `#b4006a`, relevé à l'œil sur une
> capture ; le sien est `#e10085`. Deux magentas voisins dans la même page se
> voient plus qu'une couleur franchement autre.

### Ce qui a disparu

**Toutes les descriptions.** Chaque module portait deux lignes expliquant ce
qu'il fait. Un intitulé qui a besoin d'un paragraphe est un intitulé mal choisi,
et une boîte à outils n'est pas un endroit où l'on vient lire — on y vient
allumer et éteindre. Le banc d'essai garde la règle : aucun module ne peut
reporter un `resume`, et le panneau ne peut plus en dessiner.

**Les flèches des champs numériques.** Elles sont dessinées par le navigateur,
pas par nous, et ne ressemblent à rien de ce que Roll20 emploie. Elles se
retirent des deux façons qui existent — la propriété standard et le
pseudo-élément de WebKit —, et le contrôle porte sur la feuille, seul endroit
où elles se commandent.

> Leur disparition règle un défaut mesuré au passage : une flèche tenue appuyée
> émettait **une écriture par cran**, chacune diffusée à tous les onglets Roll20
> ouverts ; et franchir 250 en tirant le maximum faisait basculer le contrôle de
> zoom de Roll20 à chaque passage, ce qui remet la table à 100 % à chaque fois.
> On n'écrit plus qu'à la validation : une saisie, une écriture.

**Les quatre coins carrés.** Le panneau n'était arrondi que d'un côté —
`0 8px 8px 0`, le bord gauche laissé droit du temps où il était collé à la barre
d'outils. Et le rayon ne suffisait pas : **une iframe est un rectangle opaque qui
repeint ses propres coins**, si bien qu'on voyait quatre angles droits dans une
boîte arrondie. Le rayon se pose donc trois fois — sur le conteneur, sur le
cadre, et sur le `<body>` du document qu'il porte.

**Quatre cent cinquante pixels de blanc.** Le panneau faisait 1018 px pour 570 de
contenu : toute la colonne, du plafond au plancher. Ceux de Roll20 épousent leur
contenu. Un conteneur ne peut pas se régler sur le contenu d'une iframe — c'est
une boîte opaque —, alors le document dedans **dit sa hauteur** par un message,
et le pont la prend, plafonnée à ce que l'écran offre.

> **Une valeur qui dépend de ce qu'elle commande ne se stabilise que par
> hasard.** Le premier jet envoyait `documentElement.scrollHeight`. Or `<html>`
> fait 100 % du cadre : la mesure valait donc la hauteur du cadre, c'est-à-dire
> celle que le message allait fixer. Le panneau s'est effondré de 1018 à
> **150 px** en trois allers-retours. On mesure le contenu, dont la hauteur ne
> dépend d'aucun cadre.

### Le thème

Trois valeurs : **automatique, jour, nuit**. Et « automatique » ne veut pas dire
la même chose des deux côtés, ce qui est voulu :

| | ce que suit « automatique » |
|---|---|
| la fenêtre du navigateur | le réglage du système (`prefers-color-scheme`) |
| le panneau, dans la partie | **Roll20**, dont le pont lit déjà le thème |

Suivre le système dans un panneau posé sur une partie serait absurde quand
Roll20 est en clair juste derrière. Un choix explicite — jour ou nuit — passe
devant les deux : un choix ne se fait pas discuter par une détection.

**La palette de marqueurs suit aussi.** Elle est peinte par le pont, avec les
couleurs qu'il relit sur la barre de Roll20 ; un thème choisi passe devant, sans
quoi on obtenait deux panneaux censés être identiques, l'un blanc et l'autre
noir, côte à côte.

> **La feuille porte trois écritures, et il en faut trois.** La palette claire
> sur `:root` nu ; la sombre sous `prefers-color-scheme: dark`, gardée par
> `:not([data-theme="jour"])` — sans ce garde, choisir le jour sur un système en
> sombre ne donnerait rien ; la sombre encore sous `[data-theme="nuit"]`, pour
> que le choix gagne dans l'autre sens.

> **Une règle de nuit peut battre une règle d'état.** `:root[data-theme="nuit"]
> .r20-bascule .rail` pèse 0-4-0 quand `.r20-bascule input:checked + .rail` n'en
> pèse que 0-3-0 : la nuit repeignait en gris les interrupteurs **allumés**.
> Quatre modules actifs, quatre rails éteints, et rien à l'écran ne le disait.
> Le `:not(:checked)` ne change pas le poids, il change la cible — les deux
> règles ne se disputent plus le même élément.

### Les deux panneaux sont le même panneau

Question posée telle quelle : « le style du panneau de paramètres est-il
identique au style du panneau de marqueurs ? » Mesurés côte à côte sur une vraie
partie, la réponse était **non**, sur quatre points :

| | palette | réglages |
|---|---|---|
| police | `proxima-nova` | `Proxima Nova` |
| taille | 12,5 px | 13 px |
| rayon | 8 px | 10 px |
| ombre | une couche | deux couches |

Ce sont maintenant les mêmes, celles relevées chez Roll20. La **largeur** reste
différente et doit l'être : 272 px n'est pas un choix mais un calcul — huit
tuiles de 28 et sept écarts de 4. Deux panneaux qui portent autre chose n'ont
aucune raison de faire la même largeur.

### Le bouton qui survivait à l'extinction

Signalé : le bouton VTTK restait dans la boîte à outils après avoir éteint
l'extension. Et c'était logique — **ce bouton ne dépend d'aucun module**, c'est
par lui qu'on les allume, il se pose donc tout seul dès que le pont est injecté.
Éteindre les modules un par un ne pouvait pas l'emporter, puisque aucun ne
l'avait mis là. On ne peut pas non plus retirer le pont : sa balise s'est effacée
à l'`onload`, et aucun script de contenu ne l'atteint. Le seul chemin est de lui
**dire**.

Vérifié sur une vraie partie, après extinction : rouage **parti**, section
**partie**, panneau **parti**, palette **partie**, zoom **parti**, chat
**parti**.

> **Et le guet ne repose pas ce qu'on vient de retirer.** Il tourne dix secondes
> après l'injection ; sans un drapeau, éteindre dans cette fenêtre-là faisait
> réapparaître le bouton au demi-seconde suivant.

### La langue

**L'anglais est le défaut**, et ce n'est pas un choix de goût : Roll20 est une
table anglophone, l'extension s'y greffe, et quelqu'un qui l'installe sans rien
régler doit lire la même langue que le reste de sa page. Le choix se range comme
les marqueurs, dans `storage.local`, sous une clé de réglage ordinaire — il
traverse donc les mêmes chemins que tout le reste, et prévient tous les onglets
ouverts.

Elle atteint **tout ce qui se lit** : les deux surfaces, les noms de modules et
de réglages, le pied de chat (« De : » / « À : », les destinataires), les huit
catégories d'émojis, les infobulles du zoom et de la palette. À chaud, sans
recharger la partie — vérifié sur une vraie partie, en basculant le réglage et en
relisant les intitulés.

**Les 697 noms d'émojis sont bilingues, et l'anglais n'est pas traduit à la
main** : il est lu dans `emoji-test.txt`, la même table qui décide du groupe et
de l'ordre. Une seule source, donc jamais un nom qui désigne autre chose que ce
qu'Unicode désigne — et le banc le vérifie caractère par caractère.

> **Un message envoyé avant que le pont existe part dans le vide.** Le
> démarrage envoyait les mots juste après avoir lancé les modules — or c'est un
> module qui injecte le pont, et cette injection est asynchrone. Mesuré : la
> palette de marqueurs restait **en français** alors que l'anglais est le
> défaut : titre, rouage, les deux modes, la croix de fermeture. Ils partent
> désormais du `onload` du pont, exactement là où le journal en retard se verse
> déjà — le seul instant où l'on sait qu'il écoute.

> **Le pont ne peut pas traduire lui-même.** Il vit dans le monde de la page, où
> le dictionnaire n'est pas. Le script de contenu lui envoie donc les douze mots
> qu'il a à dire — pas les cinquante — et le repli reste le mot français
> d'origine : un panneau sans intitulé serait pire qu'un panneau dans la
> mauvaise langue.

> **Un nom emprunté ne se voit pas ; ses effets, si.** La fonction de traduction
> du pont s'appelait d'abord `mot` — nom que trois de ses fonctions employaient
> déjà pour des variables locales, des nœuds DOM. L'appeler revenait à appeler un
> `<p>` ; l'exception partait dans le `try/catch` de l'écouteur, et la palette
> ne se construisait plus du tout.

### L'interrupteur général

Éteint, **aucun module ne démarre** — donc aucun écouteur, aucun nœud, aucun pont
injecté, et pas de bouton dans la boîte à outils. Il agit à chaud, dans les deux
sens : un interrupteur qui ne commute qu'au prochain démarrage n'est pas un
interrupteur. Et tant qu'il est baissé, rallumer un module un à un ne fait rien —
sans quoi il tournerait pendant qu'on croit tout éteint.

## Les quatre mondes

Roll20 en sert **deux**, et le rôle en fait quatre :

| | Jumpgate | héritage |
|---|---|---|
| **MJ** | ✔ | ✔ |
| **joueur** | ✔ | ✔ |

L'extension ne connaissait que la colonne de gauche. Sur une campagne
d'héritage elle **disparaissait entière** — pas de bouton, pas de panneau, pas
de pied de chat — et le seul symptôme visible était « je n'ai accès à rien ».

### Reconnaître le moteur

**Ni la toile, ni Pinia, ni `currentPlayer.d20` ne distinguent quoi que ce
soit.** Une campagne d'héritage tourne dans le **même client neuf**, et les
trois y sont. Relevé sur les deux, côte à côte :

| | Jumpgate | héritage |
|---|---|---|
| `#babylonCanvas` | oui | **oui** |
| `currentPlayer.d20` | oui | **oui** |
| Pinia (`[data-v-app]`) | oui | **oui** |
| `window.MeshScene` | **oui** | **non** |
| `d20.engine.canvas` | non | oui |

`MeshScene` n'existe que là où Babylon dessine. C'est donc lui, et rien
d'autre. Le premier jet se fiait à `#babylonCanvas` et concluait « Jumpgate »
sur une campagne d'héritage.

> **Et le pont doit ATTENDRE de savoir.** Il est injecté tôt — c'est tout son
> intérêt — et ni Babylon ni l'ancien moteur ne sont montés à ce moment-là. Une
> mesure unique à l'injection répondait « inconnu » et s'y tenait. Il réessaie
> désormais, et « inconnu » n'est annoncé qu'au bout de quinze secondes, quand
> c'est une vraie information.

### Les trois causes de la disparition

**Aucune section titrée à cloner.** On posait notre section VTTK en clonant une
des siennes *à intitulé*, et faute d'en trouver une on renonçait — donc aucun
bouton, donc aucun panneau. Relevé sur une campagne d'héritage : deux
`.spacer-outer`, **zéro** `.spacer-header`. Renoncer était le pire choix :
seule l'étiquette manquait. On clone désormais un séparateur ordinaire et on lui
greffe notre propre intitulé ; s'il n'y a même pas de séparateur, on en fabrique
un.

**Son intitulé de chat s'écrit `As:`.** Le module le cherche par son texte et
n'acceptait que « En tant que » et « Speaking as ». Un mot de moins, et la ligne
« À : » ne se posait jamais — le pied de chat entier, émojis compris, restait
absent sans qu'aucun message ne l'explique.

**Les marqueurs et la grille passent par Babylon.** Ceux-là restent muets en
héritage, et le journal le dit : « marqueurs non posés : scene-absente »,
« grille NON étendue : grille-absente ». La palette, elle, s'affiche — en repli
flottant — parce que c'est du DOM.

### Ce qui marche, mode par mode

| | Jumpgate | héritage |
|---|---|---|
| boutons et panneau | ✔ | ✔ |
| pied de chat, destinataire, émojis | ✔ | ✔ |
| palette de marqueurs (l'interface) | ✔ | ✔ |
| marqueurs **dessinés** sur la carte | ✔ | ✗ Babylon |
| grille hors carte | ✔ | ✗ Babylon |
| bornes du zoom | ✔ | ✗ autre moteur |

Vérifié sur quatre vraies parties, dont deux d'héritage — une où l'on est MJ,
une où l'on n'est qu'invité. Sur celle-là, l'essai s'est limité à **un seul
message, chuchoté à soi-même** : `8:30PM (To Rynn): vttk-essai-<identifiant>`.
Personne d'autre ne l'a vu, et rien d'autre n'a été touché — ni jeton, ni
marqueur, ni réglage.

> L'identifiant est masqué ici, et c'est une règle : **aucun identifiant de
> campagne n'entre dans un fichier versionné**. Il désigne une vraie table, avec
> de vraies personnes, et le dépôt est destiné à des pages publiques. Les sondes
> le lisent dans `outils/config.json`, qui reste local.

> **Se chuchoter à soi-même plutôt que `/talktomyself`** : la commande de Roll20
> est un INTERRUPTEUR, et elle resterait allumée derrière nous sur la table de
> quelqu'un d'autre. Un chuchotement ne laisse qu'une ligne, et il éprouve
> exactement la chaîne qu'on veut éprouver.

### Se connecter sans que Cloudflare voie un robot

Le pilote ouvrait une fenêtre « ordinaire » sur **son propre** profil pour que
l'humain s'y connecte. Ça ne marche plus, et c'est logique : geckodriver écrit
ses préférences dans ce profil, et Firefox les relit à chaque démarrage.

```
marionette.port                     63731
remote.active-protocols             1
remote.prefs.recommended.applied    true
remote.system-access-check.enabled  false
```

La fenêtre n'était donc pas sans automatisation : elle démarrait sur un profil
qui en porte les marques. `outils/connexion-humaine.js` ouvre un **second
profil**, qui ne verra jamais geckodriver, et n'en rapporte **que les cookies**.
Ce n'est pas un contournement du contrôle — c'est un humain qui se connecte dans
un vrai navigateur, et la séparation qui manquait.

> **Un verrou n'est pas un fichier.** Sur Windows, `parent.lock` survit à la
> fermeture : le tester par `existsSync` déclarait le profil ouvert alors que
> Firefox était fermé depuis longtemps. On demande à l'ouvrir en écriture — le
> système répond, et il ne se trompe pas.

> **« Chargée » ne veut pas dire « prête ».** Le pilote se contentait de la toile
> et de la barre d'outils : les deux existent avant que la partie soit montée. Il
> a rendu « chargée en 0 s » sur une page affichant encore « Chargement… », et
> tout ce qui a été mesuré ensuite l'a été sur une page à moitié faite — dont un
> verdict de version faux. Il exige désormais la campagne et sa page active.

## Ce qui faisait ramer la machine

Signalé : « mon PC rame quand j'active l'extension de zoom ». Pas *quand je
zoome* — **quand j'active**. Ce qui coûtait était donc payé en permanence.

La cause tient en une ligne, et il a fallu six mesures pour l'atteindre : un
**`$subscribe` sur le magasin Pinia de Roll20**.

### La preuve, en quatre lignes

Le même `$patch({ zoom: 165 })` sur son magasin, dans quatre conditions :

| condition | blocage du fil principal |
|---|---|
| rien d'attaché | **0 ms** |
| un `$subscribe` au rappel **vide** | **555 ms** |
| le même, retiré | **0 ms** |
| un relevé toutes les 250 ms | **0 ms** |

**Le rappel ne fait rien.** Ce n'est donc pas ce qu'il fait qui coûte, c'est
l'abonnement lui-même : `$subscribe` de Pinia n'enregistre pas seulement un
rappel, il installe **aussi un observateur profond** sur l'état du magasin, pour
attraper les écritures directes. Sur `engine`, qui porte l'état de toute la
scène de Roll20, chaque mutation faisait alors parcourir tout le graphe.

### Ce que ça coûtait à l'usage

| | avant | après |
|---|---|---|
| activation du module | **3 349 ms** | **0** |
| `setZoom` de Roll20, module allumé | 1 603 ms | 0 |
| `setZoomSilent`, module allumé | 1 140 ms | 0 |
| `stepAdjustZoom`, module allumé | 1 306 ms | 0 |
| `$patch`, module allumé | 455 ms | 0 |
| notre pas, 150 → 165 | 1 921 ms | 0 |
| dix crans hors plage, sur 8 s | **8 426 ms bloqués** | **0** |
| pire trame pendant ces crans | 1 523 ms | 18 ms |

Module **éteint**, les mêmes appels de Roll20 étaient tous gratuits. C'est cette
asymétrie qui a désigné le coupable : le coût n'était pas dans nos
remplacements — `$patch`, que nous ne remplaçons pas, était touché aussi — mais
dans ce que nous **attachions**.

> **Et c'est ce qui explique le paradoxe.** Au-delà de 250 % on n'écrit plus
> dans son magasin : plus aucune mutation, donc plus rien à parcourir. Le zoom
> « interdit » était fluide et le zoom ordinaire ramait — exactement l'inverse
> de ce qu'on attendait, et la raison pour laquelle une session entière avait
> cherché du côté des écritures hors plage.

### Une horloge, et surtout pas un abonnement

Être prévenu quand la valeur change paraissait plus propre et moins cher qu'une
horloge qui relit. C'est l'inverse, et de trois ordres de grandeur. Le pont
relit désormais le zoom **quatre fois par seconde** et n'attache rien. Le quart
de seconde de retard ne se voit pas : c'est le délai pour que le *chiffre* de la
commande suive un geste fait ailleurs, et **nos propres gestes émettent tout de
suite**, sur les deux branches — c'est dans la plage de Roll20 que le glisseur
passe le plus clair de son temps, donc n'émettre que hors plage n'aurait rien
réglé.

Vérifié après coup : les crans de molette donnent exactement la même suite de
zooms qu'avec le module éteint (113, 126, 139 … 250), à 0–3 ms le cran, et la
caméra seule encaisse toujours cinquante crans jusqu'à 1754 % sans une trame
lente.

### Le chien de garde, lui, tient toujours

L'abonnement ne servait pas qu'à suivre la valeur : il reposait **aussi** la
caméra à chaque remuement du magasin, et le cas nommé était le redimensionnement
de la fenêtre. Au-delà de 250 %, la caméra est le seul objet qui tienne le zoom :
si Roll20 recalcule ses plans orthographiques et que personne ne les repose, la
vue retombe à 250 sans que rien ne le relève.

L'horloge le fait quatre fois par seconde. Mesuré, à 450 % :

| | hauteur ortho | toile | zoom déduit |
|---|---|---|---|
| avant | 118,44 | 1066 | **450 %** |
| fenêtre rétrécie, 1,2 s après | 98,44 | 886 | **450 %** |
| trois secondes plus tard | 98,44 | 886 | **450 %** |
| fenêtre rendue à sa taille | 118,44 | 1066 | **450 %** |

La hauteur suit la toile, comme elle doit, et le zoom ne bouge pas.

> **Une relecture adverse de soixante-sept agents a examiné ce module et n'a rien
> retenu.** L'un de ses chercheurs avait pourtant nommé le bon mécanisme —
> l'observateur profond de `$subscribe` — et trois réfutateurs l'ont écarté :
> « le coût réel de quelques microsecondes annoncé comme cause d'une machine qui
> rame est une piste morte », « la fréquence annoncée n'est ni mesurée ni
> plausible ». La lecture était méticuleuse et la conclusion fausse de trois
> ordres de grandeur. C'est exactement pourquoi rien ici n'est corrigé sur la foi
> d'une lecture : le chronomètre a le dernier mot, et il a dit 555 ms pour un
> rappel vide.
>
> Le seul de leurs arguments qui portait — « le correctif défait un garde-fou
> documenté » — est celui qu'on vient de vérifier ci-dessus, et il tient.

### Les instruments, et les trois qu'il a fallu jeter

**`PerformanceObserver` sur `longtask` ne marche pas dans Firefox.** L'appel ne
lève rien, l'observateur ne signale jamais rien : quatre colonnes de zéros
parfaitement rassurantes et parfaitement creuses. La gigue d'une minuterie à
20 ms dit la même chose et se mesure partout — une minuterie qui revient au bout
de 200 ms dit qu'un travail a tenu le fil principal pendant 180.

**On n'écrit pas `browser.storage` depuis `executeScript`** : ce code s'exécute
dans le monde de la page, qui n'en a pas. On croyait éteindre le module ; on
écrivait dans le vide. Et Firefox piloté refuse de naviguer vers une page
`moz-extension`. Le pont, lui, n'attend qu'un message : le lui envoyer installe
exactement ce qu'on veut mesurer, dans le même chargement de page, donc avec le
même témoin.

**Une mesure prise sur un module qui ne s'est pas installé ne mesure que le
silence.** Le premier passage a rendu sept compteurs à zéro sans que rien ne le
signale : par défaut les bornes valent 10–250, c'est-à-dire exactement celles de
Roll20, et le module n'a alors rien à faire. La sonde vérifie maintenant qu'il
est là avant de mesurer.

**Et une sonde qui devine un chemin d'accès ment aussi.** Celle du chien de garde
cherchait la caméra par `currentPlayer.d20.engine.canvasScene` et rendait `null`
quatre fois de suite — ce qui aurait pu passer pour une caméra perdue alors que
c'était la sonde qui ne savait pas regarder. Elle emprunte désormais le chemin du
pont, `MeshScene.cameras`, et pas un autre.

Les compteurs restent dans le pont — sept entiers sur `window.__vttinkerZoom`,
lisibles d'un `executeScript`. Un compteur qui coûterait quelque chose fausserait
ce qu'il mesure ; ceux-là sont des `++`.

Deux interdits sont désormais tenus par le banc d'essai : **aucun `$subscribe`
sur un magasin de Roll20**, et **aucune sonde qui guette `longtask`**. Ce sont
des fautes qui ne se voient ni à l'exécution ni à l'œil, seulement au chronomètre
d'une vraie partie ; les laisser revenir parce que le banc ne sait pas les
nommer, ce serait accepter de repayer six mesures.

## Grille hors carte

Roll20 arrête de **dessiner** sa grille au bord de la page, alors que
l'aimantation des jetons, elle, continue au-delà : on pose un personnage hors
carte, il se cale sur la trame, et plus rien ne la montre. Le module étend
l'affichage — et rien d'autre. L'aimantation est déjà la sienne.

Relevé sur une vraie partie (`npm run grille`) :

```
maillage « tabletop-square-grid »   un quad de six sommets
  position (770, -1120)   échelle (1540, -2240)   soit 22×70 et 32×70
matériau ShaderMaterial « GridMaterial »
  uniformes : world, worldView, worldViewProjection, gridSize, color, opacity
  gridSize = [22, 32]  ← un NOMBRE DE CASES, pas une taille
  attributs : position, uv
```

**Le shader dessine en espace UV.** `gridSize` répartit un nombre de cases sur
le quad : agrandir le quad sans y toucher étirerait les cases. On fait donc les
deux, du même facteur, et la case reste à soixante-dix pixels — que le pont
**calcule** au lieu de le supposer, pour qu'une page à une autre échelle étende
la sienne de ses propres cases.

**L'alignement tient tout seul**, à condition d'ajouter des cases *entières* de
part et d'autre d'un centre inchangé : le bord passe de 0 à −70n, qui reste un
multiple de la case. Les lignes tombent exactement sur les siennes, donc sur
l'aimantation. C'est la seule raison pour laquelle ce module n'a aucun calcul de
position à faire.

### Les cinq types, et leurs deux mécaniques

Roll20 propose **Square, Hex(V), Hex(H), Dimetric, Isometric**. Relevé en les
changeant un à un (`npm run types`) — la clé de page est **`grid_type`**, avec
un souligné ; écrite `gridtype` elle crée un attribut que Roll20 ignore sans
rien dire, et les cinq relevés donnent alors le même résultat :

| type | maillage | classe |
|---|---|---|
| square | `tabletop-square-grid` | `Mesh`, quad de 6 sommets, shader UV |
| hex / hexr | `Hex-Grid-Line-System` | `LinesMesh`, ~9 800 sommets |
| dimetric / isometric | `Iso-Grid-Line-System` | `LinesMesh`, ~175 sommets |

### On PEINT la grille, on ne la trace plus

C'est la leçon la plus chère de tout le dépôt, et elle était sous les yeux depuis
le début : **Roll20 ne trace pas sa grille carrée, il la peint.** Un quad de six
sommets, un shader qui calcule la trame au pixel, et c'est le seul des cinq types
dont personne ne s'est jamais plaint.

Nous, on répétait sa géométrie : 89 000 segments pour un halo moyen, 232 000 pour
un large. Ça ramait, et c'était perdu d'avance — le coût suit la **surface** du
halo, donc le carré de ce que l'utilisateur demande. Quatre corrections
successives n'ont fait que déplacer le problème.

Aujourd'hui les cinq types sont peints. **Six sommets, un appel de rendu, et le
prix ne dépend plus que de la surface à l'écran** : quatre cents cases coûtent
exactement ce que dix coûtent.

| | avant | maintenant |
|---|---|---|
| hex | 89 300 segments | **6 sommets** |
| hexr | 82 200 segments | **6 sommets** |
| dimetric | 528 segments | **6 sommets** |
| isometric | 529 segments | **6 sommets** |

### Le repère : local, monde, et la demi-cellule

Le défaut le plus visible de la version peinte, et le plus instructif. Un
maillage Babylon porte des sommets en coordonnées **locales** et une position qui
les emmène dans le **monde**. Celui de la grille hexagonale de Roll20 est à
`(35 ; -40,41)` — ses sommets vont de `-35` à `1505`, son dessin de `0` à `1540`.

Tant qu'on **clonait** sa géométrie, la question ne se posait pas : le clone
héritait de sa position, les deux repères restaient confondus. Un **shader**, lui,
reçoit la position *monde* du fragment. Toute notre trame étant mesurée en local,
la grille peinte sortait décalée de 35 px — soit exactement **une demi-largeur
d'hexagone**. Les quatre types peints étaient faux ; le carré, qu'on ne peint pas,
était juste. C'est ce contraste qui a mis sur la voie.

Le shader retranche donc cette position, une fois, dans son vertex shader, et le
quad est posé à `position du maillage + centre du halo`. Les deux vont ensemble :
l'une sans l'autre ne corrige rien.

Le banc ne pouvait pas voir ce défaut — **ses maillages étaient tous à
l'origine**, où les deux repères se confondent. Ils portent maintenant la position
mesurée sur Roll20, et deux contrôles vérifient que le shader reçoit la position à
retrancher et que le quad est posé dans le monde.

Trois points qui font que ça ressemble vraiment à la sienne :

- **L'épaisseur du trait reste constante à l'écran**, comme un LinesMesh, sans
  qu'on ait à suivre le zoom : `fwidth()` donne la taille d'un pixel en unités
  monde. On la prend sur la POSITION et non sur la distance — la distance saute
  d'une cellule à l'autre, et son gradient y ferait un trait large.
- **L'opacité est corrigée.** Roll20 dessine ses hexagones un par un, donc chaque
  arête intérieure DEUX fois : à 0,3 le résultat vaut 1−0,7² = 0,51. Une trame
  peinte ne la trace qu'une fois et sortirait plus pâle. Pour les isométries, où
  il ne trace qu'une fois, on garde son 0,3.
- **On ne peint rien sur la page** : le shader écarte ces fragments, Roll20 y
  dessine déjà.

La phase des hexagones ne se déduit d'aucune formule — elle dit où Roll20 compte
ses centres. On l'**ajuste** par balayage, puis on la **vérifie** : tous les
sommets de sa géométrie sont sur un bord d'hexagone, donc la distance du modèle
doit y être nulle. Résidu relevé : **0 px**. Au-delà d'un demi-pixel, on n'y
croit pas et on retombe sur l'ancien pavage — qui reste en place, vérifié, pour
une machine où le shader ne compilerait pas.

### Le pavage en segments — le repli, et son histoire

**Trois mécaniques, et chacune accordée à ce que le type EST.** Le choix ne se
fait sur aucun nom de grille : le code regarde la géométrie et en décide seul.

1. **Le carré** est un shader sur un quad : on agrandit le quad et le nombre de
   cases. Rien d'autre à faire.
2. **Les hexagones** sont des CELLULES : des milliers d'arêtes courtes — 40 px
   sur une page qui en fait 1540. On répète un pavé de la trame.
3. **Les deux isométriques** sont des DROITES : quatre-vingts diagonales qui
   traversent la page de part en part. On les redessine famille par famille.

La bascule se fait sur la **longueur médiane** des segments comparée au petit
côté de la page. La médiane, et non la moyenne : les quelques segments du cadre
que Roll20 loge dans le même maillage ne doivent pas peser sur le choix.

Traiter les isométries comme des cellules les a cassées, et l'erreur valait la
leçon : le pavé garde les segments dont le **milieu** tombe dedans, or le milieu
d'une droite rognée par la page ne dit rien de sa place dans le réseau. Sur
quatre-vingt-huit droites, dix-sept disparaissaient purement et simplement, et
les autres se recouvraient.

### La période, et la parité qui a tout fait échouer

Rien n'est écrit en dur — ni mathématique d'hexagone, ni formule d'isométrie. La
période se **trouve par autocorrélation** sur les sommets, et un type de grille
qu'on n'a jamais vu se traitera comme les autres. Trois pièges, chacun payé
d'une session :

**On ne cherche la période que sur l'INTÉRIEUR.** Roll20 coupe sa géométrie au
rectangle de la page, et une arête coupée a des coordonnées quelconques, hors
trame. Elles sont nombreuses, et — c'est le point — elles se répètent au pas des
CELLULES, pas à celui de la trame : sur un pavage hexagonal, une rangée sur deux
seulement touche un bord donné. La détection y voyait donc une période **double**
— 118,135 pour `hexr` là où le réseau vaut 121,24, et 34,64 au lieu de 17,32 sur
le banc. On écarte tout segment qui touche le bord de la source.

**Un multiple entier de la période n'est pas forcément une symétrie du réseau.**
C'est la cause du défaut le plus visible, et la plus contre-intuitive. Une trame
hexagonale à sommet pointu est engendrée par (70 ; 0) et (35 ; 60,62) : une
translation *verticale* de n rangées n'en est une symétrie que si **n est
PAIR** — une rangée sur deux étant décalée d'une demi-largeur, un nombre impair
de rangées laisse ce demi-pas en travers. On tirait n de la seule hauteur de
page : sur trente et une hauteurs, **neuf** tombaient juste. Les autres
affichaient, dès le premier pixel au-delà du bord, une trame décalée d'une
demi-largeur d'hexagone — en haut et en bas pour `hex`, à gauche et à droite pour
`hexr`.

On ne raisonne donc plus sur la parité, ni sur aucune formule. On **translate, et
on regarde si ça retombe** : on essaie le plus grand pas qui tienne dans la
source, puis le suivant, jusqu'à ce que l'un passe l'examen. Et on ne juge pas
une symétrie sur ce que la page a coupé — le segment ne doit pas toucher le bord,
et son image doit tomber franchement à l'intérieur.

**L'affinage de la période se fait par la MOYENNE des écarts appariés.** La
version d'avant prenait la distance entre le premier et le dernier sommet
appariés divisée par le nombre de périodes : faux, parce que cette distance ne
mesure des périodes entières que si ses deux extrémités sont dans la même classe
de résidu, et une trame hexagonale en a deux. L'arrondi tombait sur le mauvais
entier et rendait une valeur qui n'est période de rien.

### Un seul maillage, pas une copie par tuile

La première version clonait le maillage une fois par tuile. Ça marchait, et
c'était mauvais sur les deux plans qui comptent.

**Le dessin.** La géométrie porte une colonne de lignes à *chacune* de ses deux
extrémités : deux tuiles adjacentes tracent donc la même ligne au même endroit.
À une opacité de 0,5, deux traits superposés en font un à 0,75 — une ligne plus
marquée tous les 1540 px. Aucune translation ne peut l'éviter.

**Le coût.** 168 maillages, c'est 168 appels de rendu par image, pour une
grille.

On construit donc **un** maillage, dans une géométrie propre au clone. Un appel
de rendu.

### On découpe, on ne dédoublonne pas

La version suivante répétait toute la source puis écartait les segments déjà
vus. Elle a bien supprimé les lignes doublées — et elle en a créé de **pâles**.
La mesure est sans appel : Roll20 trace 250 lignes solitaires, toutes au bord de
sa page ; nous en avions 3 436, dont 2 358 en plein milieu.

Car Roll20 **dessine ses hexagones un par un** : chaque arête intérieure est
tracée *deux fois*, et c'est ce qui donne son épaisseur à sa trame. En écarter
une sur deux à la jointure faisait un trait deux fois plus clair — une couture,
tout aussi visible qu'un trait deux fois plus sombre. Le défaut avait juste
changé de signe.

On ne compare donc plus rien. On **partitionne** : chaque segment appartient à la
tuile où tombe son **milieu**, dans un pavé semi-ouvert `[origine, origine +
pas)`. Deux segments superposés ont le même milieu, donc ils voyagent ensemble —
les arêtes doubles restent doubles, les simples restent simples, et chaque ligne
est tracée exactement autant de fois que Roll20 le fait lui-même. Ni doublon ni
pâleur, et plus aucune table : la version d'avant en tenait une de cent vingt
mille clés de texte.

Trois points, chacun payé par une mesure :

- **Le pavé se prend au MILIEU de la source, jamais à ses bords.** Roll20 coupe
  sa géométrie au rectangle de la page, en plein milieu des cellules : le long
  du bord, il ne reste que des demi-arêtes. On avait d'abord cru pouvoir garder
  toute l'étendue lorsqu'elle vaut un multiple entier de la période, en se
  disant que les deux coupes se complétaient. C'est faux — l'étendue mesure les
  sommets extrêmes, elle ne dit rien de l'endroit du motif où le trait a été
  sectionné. Ces moignons se reposaient à chaque jointure : 1 058 relevés, tous
  à vingt pixels en dedans du bord de la page, soit une demi-arête, répétés tous
  les 1540 px. On écarte donc **deux périodes de chaque bord**.
- **Ce qui retombe sur la page n'est pas émis** — c'est Roll20 qui le dessine.
  Le test porte là encore sur le milieu, avec un demi-pixel de tolérance : sans
  elle, une ligne tracée le long de la bordure revenait par-dessus la sienne.
  Un segment qui enjambe le bord avec son milieu au-dehors, on le trace
  *entier* : le bout qui rentre se superpose exactement au sien, là où un
  segment tronqué aurait laissé une encoche répétée tout le long.
- **Les segments de longueur nulle sont écartés** : la géométrie de l'hexagone
  en porte 56, qui ne dessinent rien mais occuperaient une place dans chacune
  des vingt-cinq tuiles.

Mesuré, pour 60 cases demandées :

| type | mécanique | segments posés | détail |
|---|---|---|---|
| square | quad | — | 22×31,5 → 142×151,5 cases |
| hex | cellules | 232 180 | pavé de 3 760, répété 9×7, pas 1400 × 1939,9 (40 × 32 motifs de 35 × 60,62) |
| hexr | cellules | 214 440 | pavé de 3 480, répété 9×7, pas 1212,4 × 2030 (20 × 58 motifs de 60,62 × 35) |
| dimetric | droites | 528 | 444 droites en 2 familles, écarts 62,61 / 62,61 |
| isometric | droites | 529 | 441 droites en 2 familles, écarts 60,62 / 60,62 |

### Les familles de droites

Pour chaque direction on relève le **décalage perpendiculaire** de chaque droite
— la seule grandeur qui la situe, et qui ne dépend ni de sa longueur ni de
l'endroit où la page l'a coupée. Ces décalages-là, eux, sont bel et bien alignés
sur une dimension : leur période a un sens. On redessine ensuite la famille sur
toute l'étendue voulue. Rien de rogné à recopier, aucun recouvrement possible, et
**cent fois moins de segments** — 528 au lieu de 8 926.

Un détail y a coûté un défaut visible. Le motif d'une famille, ce sont les
décalages d'**une** période : un pour une famille régulière, deux pour une
famille en paires. On le calculait au modulo — or le modulo ne recolle pas ce qui
frôle la période par en dessous, et il suffit d'un millième de dérive sur la
période pour qu'au quarantième pas le reste tombe à 62,52 au lieu de 0. La
famille paraissait alors avoir **trois** motifs au lieu d'un, ses droites
sortaient trois fois trop serrées, et la trame dimétrique ressortait **deux fois
trop dense** — mesuré à 200 %. On prend donc le reste par rapport au multiple le
plus proche, et on rapproche à un vingtième de période.

### L'instrument qui tranche : la densité

C'est celui qui manquait, et le seul qui vaille pour les cinq types : la
**longueur de trait posée par unité de surface**, mesurée en bandes qui
traversent le bord de la page. Dedans c'est Roll20, dehors c'est nous ; si les
deux trames sont la même, les bandes portent la même longueur. Une trame deux
fois trop dense, une rangée manquante, un halo qui s'arrête : tout s'y voit d'un
coup d'œil, sans rien supposer du réseau.

C'est lui qui a montré le chevauchement dimétrique (200 %) que ni les doublons,
ni les lignes pâles, ni le test de phase n'avaient signalé. Après correction :

| type | dedans | dehors | |
|---|---|---|---|
| hex | 1783 | 1743 | 98 % |
| hexr | 1731 | 1747 | 101 % |
| dimetric | 971 | 972 | 100 % |
| isometric | 1021 | 1018 | 100 % |

Les deux pour cent d'écart sur les hexagones sont un artefact de mesure : les
bandes font 60 px et la période 60,62, donc chaque bande échantillonne une phase
un peu différente.

**Une case veut dire la même chose partout.** Sur une trame hexagonale, la plus
petite des deux périodes vaut exactement la moitié de la case de Roll20 — 35 pour
`hex` comme pour `hexr`, l'axe changeant mais pas la valeur. Sans ça, « 60 cases »
achetait 4200 px en carré et 2764 en hexagonal, et le halo de `hex` sortait plus
étroit que haut alors que les écrans sont en paysage. Les cinq types donnent
aujourd'hui 4200 px, à l'isométrie près (3909).

Le nombre de tuiles est borné par le **travail total** (400 000 segments) et non
par un compte choisi au hasard : une grille à soixante-huit segments en supporte
bien plus qu'une à quatre mille.

### Suivre les changements de type

Le guet ne surveillait que la **mort** de nos copies. Or au changement de type,
Roll20 remplace *son* maillage — et les nôtres survivent : rien ne se
déclenchait, et l'ancienne trame restait par-dessus la nouvelle. Il surveille
donc la **source**, et les quatre passages d'une famille à l'autre ont chacun
leur ménage : carré → lignes, lignes → carré, lignes → lignes (source changée),
et plus de grille du tout.

### Deux pièges, tous deux invisibles aux chiffres

**La matrice de monde est figée.** Écrire `scaling` ne suffit pas : la propriété
se laisse écrire, se relit à la bonne valeur, et le quad ne bouge pas. Résultat
mesuré comme un succès et faux à l'écran — les 142 cases se serraient sur la
largeur de la carte, une trame deux fois plus fine et toujours rien au-delà du
bord. Il faut `unfreezeWorldMatrix`, `computeWorldMatrix(true)` et
`refreshBoundingInfo`. Le pilote relève désormais la **boîte englobante** et non
la propriété : c'est elle qui dit si le maillage a vraiment grandi.

**Un échec n'est pas un aboutissement.** La scène Babylon se monte après la
page : le premier envoi tombe sur une grille qui n'existe pas encore, et le pont
répond `grille-absente`. Les deux modules cessaient de réessayer sur cette
réponse — la feature restait morte. Ils ne s'arrêtent plus que sur un succès.

### Comment le zoom est prolongé

**On ne remplace pas le zoom de Roll20, on le prolonge aux extrémités.** Entre
10 % et 250 % Roll20 fait tout son travail, sans qu'on touche à rien — y
compris ce qu'il fait et qu'on ne voit pas. On ne prend la main que là où il
refuse d'aller.

C'est imposé par ce que l'écoute a montré : **chaque appelant borne avant
d'appeler**. La molette, arrivée à 241,625, ne demande pas 254,5 mais exactement
250 ; puis, collée à la borne, elle n'appelle plus du tout. Remplacer `setZoom`
ne suffisait donc pas.

Les trois entrées, et ce que le module en fait :

| entrée | chaîne réelle | traitement |
|---|---|---|
| boutons `+` / `−` | `stepAdjustZoom(booléen)` → `setZoom` → `setZoomSilent` — le booléen est le **sens**, pas un delta ; pas de 10, arrondi aux dizaines | délégué tel quel dans la plage native, repris au-delà |
| molette | appelle `setZoomSilent` **directement**, pas linéaire de 12,875 par cran de `deltaY = ±102` | interceptée en capture sur la fenêtre, et **seulement** quand Roll20 refuserait |
| slider | passe par `setZoom` | remplacé |

Le pas du prolongement est **proportionnel** (13 % du zoom courant) là où celui
de Roll20 est linéaire : à 800 %, un pas fixe de 12,875 demanderait soixante
crans pour doubler, et à 3 % il ferait passer sous zéro. 13 % vaut justement
12,875 à 100 %, donc la jonction ne se sent pas.

### Au-delà de 250 %, on ne le prévient pas

**Signalé par l'auteur : passé 250 %, la partie ramait très fort.** Chronométré
sur une vraie partie, en mesurant les **trames** autour de chaque cran de
molette — et non les appels, qui ne coûtent rien :

| | pire trame par cran |
|---|---|
| dans sa plage (120 → 240) | **9 à 29 ms** |
| au-delà (300 → 500) | **537 à 852 ms** |
| à cheval sur 250 | jusqu'à **2 209 ms** |

Et la scène passe de **onze à quarante-six textures**. Au-delà de sa borne,
Roll20 refait son fond à la résolution demandée, et il le refait **à chaque
cran** : dix crans de molette, c'est dix reconstructions — cinq secondes de gel
pour un geste d'une seconde.

> **Ce n'est pas notre code qui coûte.** Décomposé morceau par morceau, un cran
> hors plage fait **0 à 1 ms** de travail synchrone : `setZoomSilent`, le
> `$patch` sur son magasin et l'écriture de la caméra sont chacun sous la
> milliseconde. Le gel est entièrement dans ce que Roll20 fait *ensuite*, sur sa
> boucle de rendu. Aucun réglage de notre côté ne l'aurait rendu moins cher.

On ne peut pas l'en empêcher. **On ne le prévient donc plus du tout.** Au-delà
de 250 %, seule la **caméra** est écrite — c'est elle qui produit l'image, et elle
coûte quatre nombres. Le magasin de Roll20 garde la dernière valeur qu'il ait
comprise, et il ne reconstruit rien.

| | mesuré |
|---|---|
| caméra seule, cinquante crans | **6 ms** par trame, **1754 %** atteint en 3 s |
| textures créées | **zéro** |
| la caméra tient-elle ? | oui — deux secondes plus tard, et après un clic sur le plateau |

> **Un premier correctif différait l'écriture à la fin du geste** : une
> reconstruction au lieu de dix, ce qui rendait le geste fluide. Mais on ne zoome
> pas d'un seul mouvement — on tourne un peu, on regarde, on tourne encore — et
> il restait **une pause d'une à deux secondes par salve**. L'auteur l'a sentie
> une seconde fois. Le délai a donc été supprimé avec l'écriture.

**Ce qu'on perd, et c'est un choix assumé** : son fond reste rendu à la dernière
résolution qu'il connaisse, donc l'image est **floue en proportion du
dépassement**. Les tokens, la grille et nos marqueurs, eux, restent nets — ce sont
des maillages, ils suivent la caméra. L'arbitrage a été posé à l'auteur, qui a
préféré la fluidité constante au piqué payé d'une seconde de gel.

**Dans sa plage, rien ne change** : c'est lui qui tient le zoom, il le fait bien
et pour trois fois rien. Et **redescendre sous 250 lui rend tout** — c'est le seul
moment où il apprend quelque chose, et le seul où il reconstruit.

> **Par prudence, la caméra est reposée** à chaque remuement de son magasin
> (soixante fois par seconde au plus, et seulement hors de sa plage). Rien de
> mesuré ne dit qu'il la reprend ; mais un redimensionnement de fenêtre est un
> cas qu'on n'a pas éprouvé, et quatre nombres réécrits coûtent moins cher que
> la question.

### Le bornage est tout en bas, et le contrôle de Roll20 doit être masqué

Deux faits mesurés sur une vraie partie, et ils commandent toute la forme du
module.

**`setZoomSilent` borne lui-même** : `setZoomSilent(400)` rend 250,
`setZoomSilent(5)` rend 10. Ce n'est pas la couche innocente que ses appelants
protégeaient — c'est elle qui refuse. Tous les chemins y passent. Seul
`$patch({zoom: 400})` écrit l'état sans rien exécuter, et il passe. **La caméra
doit donc être posée par nous** pour toute valeur hors plage : c'est ce que fait
`pose()`, et la formule est exacte au dixième.

**Le contrôle de zoom de Roll20, affiché, annule tout.** Il surveille l'état et
le repousse dans sa plage en moins de soixante millisecondes, dans les deux
sens ; son slider est un `el-slider` borné à 0-100, une échelle normalisée, dont
la boucle se referme toujours. Et il est **affiché par défaut**. Ce n'est donc
pas une réserve marginale : sans le masquer, le module est installé, ses actions
sont bien remplacées, et il ne se passe strictement rien.

Mesuré, contrôle masqué : `250 → 260 → 270 → 281 → 292` aux boutons,
`250 → 306` à la molette, `10 → 5` vers le bas, caméra à l'appui à chaque pas.

**Le module masque donc ce contrôle de lui-même**, dès que les bornes sortent de
celles de Roll20 — et lui rend son réglage intact à l'extinction.

Ça a été un réglage, ça n'en est plus un. Tant que masquer coûtait son glisseur
et trois de ses cinq boutons, l'arbitrage revenait à qui utilise l'extension, et
une case le posait. Depuis que le module rend **à la place** une commande de
mêmes dimensions, aux mêmes couleurs et à la même place, il n'y a plus rien à
arbitrer : une case qui n'ouvre aucun choix n'est pas un réglage, c'est une
corvée.

### La commande de zoom

Puisqu'on retire son glisseur à Roll20, on lui en rend un — qui couvre, lui,
toute la plage étendue. C'est ce qui a rendu le masquage gratuit, donc
automatique, donc muet : **il n'y a rien à demander à qui utilise l'extension**.

**Une seule barre de zoom à l'écran, toujours.** Le pont masque celle de Roll20
de lui-même ; si ce masquage échouait un jour — réglage renommé, action
disparue —, la sienne serait encore là et c'est **la nôtre qui s'efface**, avec
un mot dans le panneau. Deux glisseurs côte à côte, dont un qui s'arrête à 250,
seraient pires que pas de glisseur du tout.

### Il entre dans le panneau de Roll20, il ne s'installe pas à côté

Relevé sur une vraie partie, la boîte de zoom est faite ainsi :

```
#vm_zoom_buttons > .wrapper > .parentContainer
    32 px de large, colonne, fond translucide, bord 1 px, coins 8 px
  > button.el-button   30 × 34, FOND TRANSPARENT, coins 10 px
```

**C'est `.parentContainer` le panneau visible.** Se poser un cran plus haut,
dans `.wrapper`, met notre colonne *à côté* de la sienne ; y ajouter notre
propre fond, notre bord et notre ombre donne deux plaques accolées dont l'une
deux fois trop haute. On y entre donc, et on n'apporte **aucun décor** : ni
fond, ni bordure, ni ombre, ni remplissage. Les couleurs s'héritent, si bien que
le thème clair ou sombre de Roll20 s'applique tout seul. Le décor n'existe que
pour le repli flottant, quand cette boîte n'est pas là.

Même logique pour la forme : **vertical, dans l'ordre de Roll20** — valeur, `+`,
glisseur, `−` —, boutons à ses dimensions, et pas de poignée de repli puisqu'il
n'en a pas. On ne réinvente pas la disposition d'une commande que les gens ont
déjà dans l'œil : c'est la raison qui fait cloner un bouton natif plutôt que
d'en dessiner un.

Le glisseur garde le rendu vertical **natif** du navigateur, coloré par
`accent-color`. C'est la seule façon d'en avoir un qui marche partout sans
redessiner piste et curseur pour chaque moteur — et c'est ce que fait Roll20,
dont le glisseur natif est violet.

### On ne dessine pas ses boutons, on les CLONE

Ses `+` et `−` ne sont pas des caractères : c'est la police **Roll20Icons**, et
le glyphe est le mot `plus` ou `minus` écrit dans un span. Un `+` tapé au
clavier n'aura jamais ni son dessin ni sa taille, quelle que soit la valeur
qu'on donne à `font-size`. Trois raisons de cloner, toutes mesurées :

- **la police d'icônes** et donc le dessin exact ;
- **son CSS est scopé** — ses règles s'écrivent `…[data-v-2f0bc668]`, et le
  condensat change à chaque déploiement. `cloneNode` emporte ces attributs sans
  qu'on en devine un seul, et emporte aussi la variable en ligne `--v7353a950`
  qu'ils posent sur l'icône ;
- **le thème suit tout seul.** Que Roll20 change de mode, ou qu'une extension de
  mode sombre repeigne la page, elle repeint nos clones exactement comme ses
  originaux : mêmes classes, mêmes attributs. C'est la seule façon d'être juste
  dans un thème qu'on ne connaît pas.

`cloneNode` ne copie **aucun** écouteur : le clone arrive inerte, et c'est nous
qui lui posons le sien.

Le glisseur, lui, ne se clone pas — c'est un composant Vue, un clone en serait
la coquille morte. On lui prend ses **couleurs**, telles qu'elles sont rendues à
cet instant, et on les repose sur le nôtre en variables. Ce sont les mêmes dans
ses deux thèmes, vérifié ; mais elles ne le seront pas forcément demain, ni sous
une extension qui repeint.

**Le modèle se prend avant de masquer.** Une fois sa commande masquée, il n'y a
plus rien à cloner : le module attend qu'elle paraisse — six secondes au plus —
puis envoie l'installation. Si elle ne vient jamais, parce qu'elle est déjà
masquée dans les réglages du joueur, la feature marche quand même avec des
boutons de repli.

### Deux pièges d'hôte, que seule la comparaison côte à côte révèle

`npm run compare` photographie **sa** commande et **la nôtre**, chacune seule et
à sa taille — `takeScreenshot` sur l'élément, pas sur la page — puis mesure les
deux. C'est ce qui a montré, en une passe, ce que trois tours d'observation à
l'œil avaient manqué :

- **Roll20 borde tous les `input`.** Sa feuille pose `border: 1px solid #ccc`
  sur la balise, ce qui attrape notre glisseur : un cadre gris courait autour,
  que le sien n'a pas. On ne le voit qu'en comparant.
- **`box-sizing` ne descend pas dans les pseudo-éléments.** La règle
  `.vttk-zoom *` ne touche pas `::-moz-range-thumb` : les 2 px de contour
  s'ajoutaient aux 16, soit 20 contre 16 chez lui. Un curseur visiblement plus
  gros, pour une valeur pourtant recopiée à l'identique.

Et un troisième, côté persistance : **le masquage de son contrôle est enregistré
dans le compte Roll20**. Laissé masqué en fin de session, il l'était encore à la
suivante — le module n'avait alors plus rien à cloner et retombait sur des
caractères deux fois plus petits, à chaque partie. Le défaut s'aggravait tout
seul. Le module **réclame donc sa commande** (`zoom-devoile`) quand elle manque,
et la lui **rend visible à l'extinction**, toujours.

### Ses dimensions

Les **siennes, relevées** — `npm run natif` les remesure quand on veut :

| | Roll20 | nous |
|---|---|---|
| colonne intérieure | `.zoomButtonsInner` 30 × 272, sans espacement | 30 × 272, sans espacement |
| valeur | bouton 30 × 34, 14 px/500 | case 30 × 34, 14 px/500 — mais elle se **tape** |
| `+` et `−` | 30 × 34, 16 px/500, coins 10 px | idem |
| glisseur | 40 × 170, piste 8 px `#edf5fa`, remplissage `#b4006a` | idem, redessiné |
| place | entre l'œil et la mire | entre l'œil et la mire |

> Quatre tours ont été perdus ici parce que je concluais sur des chiffres sans
> regarder le résultat, puis sur une capture de trente pixels de large sans
> mesurer. `327 × 34` est un chiffre juste pour une plaque posée au mauvais
> endroit ; et l'œil ne tranche pas un ordre d'éléments sur une image minuscule.
> **Les deux, à chaque fois** : `npm run zoom` écrit une capture *et* relève
> l'ordre des enfants avec leurs coordonnées.

Deux choix qui se voient à l'usage. **L'échelle est logarithmique** : sur 2-600 %,
un glisseur linéaire passerait les quatre cinquièmes de sa course au-dessus de
120 % et les petits zooms seraient intouchables ; en logarithmique, un même
déplacement double ou divise par deux où qu'on soit. Et **la valeur se tape** :
arriver à 380 % au glisseur est une corvée.

Il **ne calcule rien** — ni le pas, ni le bornage, ni la caméra. Il affiche une
valeur que le pont lui pousse (à chaque changement, molette de Roll20 comprise)
et lui demande ce qu'il veut. Deux escaliers pour le même zoom finiraient par
diverger.

Deux détails que seul le pilote pouvait révéler : basculer ce contrôle **remet
le zoom à 100 %** — c'est Roll20 qui le fait ; et à l'extinction, il faut
**raccorder la caméra à l'état**, sinon la vue reste où le module l'avait
laissée et plus rien ne la recale.

## Roll20 sous Jumpgate — ce qui a été relevé sur une vraie partie

### `d20` n'est pas mort, il a quitté `window`

`window.d20` rend `undefined`, et c'est le piège : on en conclut que dix ans
d'acquis des extensions Roll20 sont perdus. Faux. L'objet `d20` complet —
`engine`, `Campaign`, `textchat`, `journal`, `canvas_overlay`, `models`,
`token_editor`, `dice_engine`, `iframeListeners` — est **accroché aux modèles
Backbone** :

```js
window.currentPlayer.d20          // le chemin court
window.Campaign.engine            // Campaign porte aussi engine
Campaign.players.models[0].d20    // n'importe quel modèle joueur
```

`Campaign`, `currentPlayer`, `Backbone`, `BackboneFirebase` et `FIREBASE_ROOT`
sont tous restés sur `window`. Le modèle de données n'a pas bougé.

### Le reste de la carte

| | |
|---|---|
| moteur | `vttEngine === "jumpgate"`, `JUMPGATE_ENABLED === true` — l'ancien mode existe donc encore |
| rendu de la table | **Babylon.js** : un `<canvas id="babylonCanvas">` en WebGL2, et un `window.MeshScene` qui est une Scene Babylon. `THREE` et `CANNON` traînent encore, mais ce sont les vieux dés 3D |
| interface | Vue 3 + **Element Plus**, douze applications `[data-v-app]` autour d'un **Pinia** unique de trente magasins |
| CSS | scopé par condensat (`data-v-2e62d97c`), qui change à chaque déploiement : **on clone un élément natif, on n'en reconstruit jamais un** |
| zoom | magasin `engine` : état `zoom` (pourcentage) et actions `setZoom`, `setZoomSilent`, `stepAdjustZoom`. À côté, `window.zoomLevel` vaut 1 — un facteur, pas un pourcentage |
| porte de service | `webpackChunkvtt` est exposé : on peut en tirer le `require` interne du bundle. Dernier recours, mais elle est là |

**Les sources d'actions Pinia sont illisibles de l'extérieur** : `String(store.setZoom)`
rend l'enveloppe `wrapAction` de Pinia, l'implémentation restant captée dans la
fermeture du bundle. Et **`d20.engine` est une coquille vide côté zoom** : il porte
encore `canvasZoom` (figé à 1) et `zoomStart`, mais aucune fonction de zoom. Cette
piste est morte, ne pas la rouvrir. Reste à renoncer à lire, et à **essayer**.

### Le zoom : ce que l'expérience a mesuré

La table est rendue par une **`FreeCamera` orthographique** nommée
`vtt-main-camera`, et le zoom y est exactement, vérifié au centième à 10 %, 100 %
et 250 % contre un canevas de 617 × 1066 :

```
orthoTop   =  (hauteur / 2) * (100 / zoom)      orthoBottom = -orthoTop
orthoRight =  (largeur / 2) * (100 / zoom)      orthoLeft   = -orthoRight
```

**Il y a deux bornages, pas un**, et l'expérience en cinq temps les a séparés :

- **`setZoom` borne lui-même** à `[10, 250]`. Éteindre le contrôle de zoom n'y
  change rien : 400 revient à 250 dans les deux cas.
- **`$patch({zoom: 400})` passe** quand le contrôle est éteint, et se fait
  ramener à 250 quand il est affiché : le slider Element Plus re-borne son
  modèle, mais en second seulement.

Deux faits qui décident de la suite. **Rien ne surveille l'état pour déplacer la
caméra** — avec l'état à 400, la caméra n'a pas bougé d'un pixel : c'est
`setZoom` qui la déplace, pas un observateur, donc la piloter nous-mêmes ne se
bat contre personne. Et **la caméra accepte qu'on l'écrive** : les quatre plans
posés à la main pour 400 % ont tenu 600 ms sans que rien ne les écrase, et la
vue a effectivement changé.

Reste la signature de **`stepAdjustZoom`** — par où passent la molette et les
boutons `+` / `−`, donc ce qui compte vraiment, le slider ne pouvant de toute
façon pas produire de valeur hors de sa propre plage. Elle ne se devine pas,
elle s'écoute : voir `__vttinkerEcouteZoom()`.

### La reconnaissance

Le pont ne modifie rien tant qu'une cible n'est pas identifiée. Il sait en
revanche dire ce que contient la page. Depuis la console de la **page** :

```js
__vttinkerEcouteZoom()      // écoute PASSIVE : zoome à la main, puis relis le journal
__vttinkerTestSlider()      // le slider re-borne-t-il ? (état seul, aucune écriture caméra)
copy(__vttinkerRecon())     // état du zoom vu de partout, d20.engine, caméras Babylon
copy(__vttinkerGlobales())  // les 182 globales de Roll20, avec leur type
```

`__vttinkerEcouteZoom()` n'écrit **rien** : ni caméra, ni état, ni réglage. Elle
observe (`$onAction` de Pinia, molette en `passive`) pendant qu'on zoome à la
main, et relève pour chaque appel l'action, ses arguments, le zoom avant et après
et la position de la caméra. C'est comme ça qu'on apprend une signature qu'aucune
documentation ne donne : en regardant le site s'appeler lui-même.

Les sondes qui écrivent remettent toujours l'état de départ, en dernière étape et
quoi qu'il arrive — c'est la table de quelqu'un, et un essai qui laisse la vue de
travers n'est pas un essai.

## L'ancien moteur — les trois modules qui n'y marchaient pas

Roll20 sert **deux moteurs derrière le même client**. Une campagne d'héritage a
la même barre d'outils, le même tchat, la même commande de zoom à l'écran — et
dessous, ni Babylon ni scène : `d20.engine` et un canevas Fabric.

Trois modules ne marchaient donc que sous Jumpgate, parce que les trois
passaient par Babylon : **les bornes du zoom**, **les marqueurs dessinés**, **la
grille hors carte**. Ils ont été portés. Chaque décision ci-dessous vient d'une
mesure sur une vraie partie ; aucune ne vient d'une analogie avec l'autre
moteur, et plusieurs contredisent ce que l'analogie aurait donné.

### Le magasin de Pinia existe, et il est vide

C'est le premier piège, et il ne lève pas.

```
Pinia.engine.setZoom(150)      TypeError, et rien ne bouge
d20.engine.setZoom(2)          canvasZoom 1 → 2, la carte suit
```

Le magasin `engine` **est là** — Pinia tourne des deux côtés — mais il ne porte
ni `zoom`, ni `setZoom`, ni `stepAdjustZoom`. Une branche qui l'interrogerait ne
lèverait pas : elle rendrait `null` en silence, et le module aurait l'air
éteint. D'où l'aiguillage **avant toute lecture de magasin**, dans les quatre
fonctions publiques du zoom.

Ce qui alimente le chiffre affiché, c'est un autre magasin —
`vttTools_tabletopState.zoom` —, qui n'a **aucune action** et n'est qu'un
miroir : écrit seul, mesuré, la carte ne bouge pas d'un pixel.

### Le zoom : son unité, ses portes, son travail

**L'unité n'est pas la sienne.** `canvasZoom` vaut 1 à cent pour cent, là où le
magasin de Jumpgate porte 100. Le module parle en pour cent partout et ne divise
qu'au dernier moment ; écrire `canvasZoom = 400` mettrait la carte à quarante
mille.

**Le pas est additif**, et il a été mesuré à trois altitudes :

| zoom de départ | un cran de molette | écart |
| --- | --- | --- |
| 50 % | 58,58 % | 8,5833 |
| 100 % | 108,58 % | 8,5833 |
| 200 % | 208,58 % | 8,5833 |

Contre 12,875 sous Jumpgate. Le taux du prolongement géométrique est donc
8,5833/250 pour la molette et 10/250 pour les boutons — dont le pas a été relevé
à 109 → 119.

**Son `setZoom` borne par un import interne**, qu'on ne peut ni remplacer ni
contourner. Mais tout ce qu'il fait *ensuite* est lisible, et chaque pièce est
atteignable. Il calcule un **rapport** — `zoomValue / canvasZoom` — l'applique
aux contextes 2D, puis écrit `canvasZoom`, écrit le miroir, prévient sa couche
WebGL, resitue les objets et redessine. On refait exactement cette liste avec
notre valeur. Et comme le rapport se calcule depuis `canvasZoom`, que nous
tenons à jour, **le retour dans sa plage se fait tout seul** : son `setZoom`,
rappelé depuis 400 %, calcule 2,5/4 et rescale juste.

### L'événement est à nous dès que Roll20 se comporterait mal

C'est la correction qui a coûté le plus cher, et elle a rejailli sur Jumpgate.

Le premier jet interceptait `slideZoom` et lisait le **sens** du geste dans la
valeur reçue : plus haute que le zoom courant, on monte. À 800 %, deux crans
opposés ont donné **800 → 773 → 746** : les deux vers le bas. La raison est dans
sa source — son gestionnaire ne calcule pas son cran depuis `canvasZoom` mais
depuis une variable retenue *dans* `slideZoom` (`T=ee`). Dès qu'on cesse de lui
déléguer, cette variable se fige, la valeur reçue devient constante, et le sens
du geste est indéchiffrable. Il fallait donc le geste lui-même, c'est-à-dire
l'événement.

Puis, l'écouteur posé, un cran vers le haut à 800 % **ramenait la carte à
250 %**. L'écouteur voyait bien qu'on était à *notre* borne et renonçait — mais
il renonçait **sans avaler l'événement**. Roll20 le recevait alors, calculait son
cran, et le bornait à sa plage. Refuser un geste et le laisser passer, c'est le
donner à quelqu'un d'autre.

La coupure vient donc **avant** les tests de nos propres bornes, dans les deux
modules : le même défaut dormait dans celui de Jumpgate, où il ne se voyait
qu'exactement à la borne haute réglée.

### Aucune de ses surfaces ne convenait

Pour les deux modules qui dessinent, il fallait une surface. Trois relevés, trois
impasses :

- **Sa toile visible est la seule du document, et c'est `#babylonCanvas`** — même
  en héritage. Elle est en WebGL : rien à y peindre en 2D.
- **Son canevas Fabric n'est pas au document.** `lowerCanvasEl` et
  `upperCanvasEl` sont des tampons hors écran, téléversés ensuite comme textures.
  Deux essais ont été perdus à peindre dedans : la peinture réussissait, sans
  erreur, **et rien n'apparaissait**.
- **`onAfterFOWRenderCallbacks` n'est jamais appelé** sans brouillard : un rappel
  poussé dedans n'a pas été invoqué une seule fois en trois secondes.

D'où **notre calque** : une toile à nous, par-dessus la sienne, à la même taille
et à la même place, qui ne reçoit aucun clic. On ne touche à rien de son rendu —
ni sa boucle, ni ses tampons, ni sa couche WebGL.

**La conversion**, éprouvée deux fois :

```
écran = (page − currentCanvasOffset) × canvasZoom
```

Elle a été vérifiée **en peignant**, jamais en calculant : un cadre rouge sur
chaque jeton, et l'on regarde s'il tombe dessus. La première fois à zoom 1 et
décalage nul — c'est-à-dire dans le seul cas où l'identité tombe juste par
accident, donc où la mesure ne prouve rien. La seconde à 200 % et vue déplacée,
décalage `[151, 551]` : le cadre tombait exactement sur le jeton. C'est
celle-là qui compte.

**Le rythme.** `renderLoop` bat à la fréquence de l'écran — 180 par seconde,
exactement les trames du navigateur — et tout le reste ne bat que sur événement.
On ne l'enveloppe pas pour autant : notre propre trame fait le même travail et se
retire d'un seul appel.

### Ce que la trame coûte, compté et non estimé

« Je veux un outil optimisé » ne se vérifie pas en relisant du code. Le calque
tient donc un compteur — `window.__vttinkerCalque` : trames, millisecondes
cumulées, pire trame —, comme le zoom tient les siens.

Premier relevé, et il était mauvais : avec **deux jetons et aucun marqueur à
nous**, le peintre coûtait déjà **0,11 ms par trame**. Il payait pour ne rien
dessiner. Deux dépenses, toutes deux évitables :

- il parcourait **tous les objets du canevas** avant de savoir s'il aurait quoi
  que ce soit à peindre — trente-huit objets par trame, pour rien ;
- il **redécoupait `statusmarkers`** à chaque trame et pour chaque jeton, avec
  une recherche de catalogue par étiquette, alors que cette chaîne ne change
  qu'au moment où quelqu'un pose un marqueur.

Le parcours est devenu paresseux, le découpage est retenu par chaîne. Ce que ça
donne, sur la même partie :

| | avant | après |
| --- | --- | --- |
| la grille seule | 0,106 ms | 0,137 ms |
| les deux peintres, aucun marqueur posé | 0,216 ms | **0,127 ms** |
| tous les jetons marqués | 0,340 ms | **0,196 ms** |
| ce que ça fait d'un cœur, au pire | 5,95 % | **3,45 %** |
| images du navigateur | 181 → 175 | 181 → 176 |

Le peintre des marqueurs ne se distingue plus de la grille seule quand personne
ne porte de nos marqueurs : c'est dans le bruit. Et la pire trame reste à 2 ms,
c'est-à-dire sous une image même à cent quatre-vingts hertz.

### Les marqueurs : sa loi, relevée au pixel

Poser huit marqueurs sur un jeton ne crée **aucun objet de canevas** — 38 objets
avant, 38 après. Il les peint directement dans son tampon, donc il n'y a rien à
lire comme on lit ses quads sous Jumpgate.

On a donc relevé sa rangée au pixel, en cherchant chaque teinte dans
`lowerCanvasEl`. Sur un jeton de 39,17 de côté, à 250 % :

| nombre de marqueurs | pas mesuré | `22 × min(1, largeur / 22n)` |
| --- | --- | --- |
| 2 | 19,4 | 19,6 |
| 3 | 13,0 | 13,05 |
| 5 | 7,9 | 7,83 |
| 7 | 5,6 | 5,59 |

C'est **exactement la loi de repli du module de Jumpgate**, au demi pour cent. Le
côté suit (19 × échelle), et le premier centre est à 12,5 × échelle du coin
haut-droit : pour sept marqueurs, le dernier tombe à 3,1 du bord droit quand la
formule dit 3,2. Les trois constantes valent donc pour les deux moteurs, et le
peintre hérité n'en invente aucune.

Ce qu'il n'a **pas** à faire, en revanche : ni pose par jeton, ni signature, ni
abonnement Backbone, ni rendez-vous différé pour les nœuds qui manquent. Un
peintre repart de l'état courant à chaque trame ; il n'y a rien à synchroniser,
donc rien qui puisse se désaccorder. Il lit la position sur l'**objet de
canevas** quand il le trouve — c'est lui qui suit la souris pendant qu'on traîne
un jeton, le modèle ne bougeant qu'au lâcher.

### La grille : on ne redessine pas la sienne, on lui fait dessiner la nôtre

Le module de Jumpgate compte deux mille lignes, et pour cause : il lui faut
reconnaître cinq types de grille sur les maillages de Babylon. Ici, rien de tout
ça — et c'est sa propre source qui l'a dit :

```js
drawGrid(T) { … R == "hex"  ? d(T, -k, -x, P, B, "cols")
                : R == "hexr" ? d(T, -k, -x, P, B, "rows")
                : R === "dimetric" || R === "isometric" ? r(T, -k, -x)
                :               e(T, -k, -x, P, B) }
```

**`T` est un contexte 2D, passé de l'extérieur**, et la fonction aiguille
elle-même sur le type de grille. On lui donne le nôtre : les cinq types, sa
géométrie, sa couleur, son opacité, son épaisseur. Il n'y a rien à faire
coïncider, puisque c'est le même code qui dessine les deux.

Trois choses le rendent possible, et aucune ne se devinait :

1. **Elle ne se borne pas à la carte.** On a d'abord cru que si : sa grille
   s'arrête net au rectangle de la page, la photo à 30 % le montre. Mais appelée
   sur notre calque elle a peint **6 322 pixels au-delà**. Le bornage est fait
   ailleurs par Roll20. Contre-épreuve : en lui mentant sur la taille de la page,
   dix cases de plus de chaque côté, les chiffres n'ont pas bougé d'une unité.
2. **Elle dessine en coordonnées de page.** Au premier essai notre grille était
   trois fois trop grande : à 30 %, ses cases faisaient 70 pixels d'écran quand
   celles de Roll20 en faisaient 21. La raison est dans son `setZoom` —
   `contextContainer.scale(s, s)` : son contexte porte le zoom en transformation
   accumulée, le nôtre était à l'identité.
3. **Le découpage se pose avant la transformation.** `clip` retient la région en
   espace du périphérique : on trace le contour en pixels d'écran, transformation
   à l'identité, *puis* on pose l'échelle.

Résultat mesuré, à 30 % comme à 60 % : **zéro pixel de nous à l'intérieur de sa
carte**, et le prolongement se raccorde dans l'alignement de ses lignes. Sans
grille chez lui, on ne peint rien — prolonger ce qui n'existe pas reviendrait à
dessiner une grille là où le MJ a choisi de n'en pas avoir.

### Les sondes de l'ancien moteur

```
node outils/pilote.js commande  <id>   qui commande le zoom : Pinia ou d20 ?
node outils/pilote.js pasancien <id>   le pas de la molette, à trois altitudes
node outils/pilote.js porte     <id>   quelle porte chaque commande franchit
node outils/pilote.js borne     <id>   l'appelant borne-t-il avant d'appeler ?
node outils/pilote.js srczoom   <id>   la source de son setZoom
node outils/pilote.js boucle    <id>   ce qui bat, et à quelle fréquence
node outils/pilote.js reperes2  <id>   la conversion, ÉPROUVÉE EN PEIGNANT
node outils/pilote.js vue       <id>   le déplacement de la vue, et le décalage
node outils/pilote.js loi       <id>   sa rangée de marqueurs, relevée au pixel
node outils/pilote.js srcg      <id>   la source de sa grille
node outils/pilote.js dg        <id>   son drawGrid veut-il peindre chez nous ?

node outils/pilote.js zh        <id>   le zoom hérité, à l'épreuve
node outils/pilote.js emh       <id>   les marqueurs hérités, à l'épreuve
node outils/pilote.js egh       <id>   la grille héritée, et les trois ensemble
node outils/pilote.js jg        <id>   Jumpgate n'a pas régressé
```

Celles qui écrivent rendent ce qu'elles empruntent **dans un `finally`**, et
c'est une leçon payée : la restitution était la dernière ligne du corps, une
exception au milieu a laissé une table d'essai habillée d'une grille verte
jusqu'à la course suivante.
