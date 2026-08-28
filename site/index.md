---
hide:
  - navigation
---

<div class="vttk-banniere" markdown>
<span class="vttk-version">version 0.50.0</span>

# Des outils pour Roll20

Les bornes du zoom, la grille au-delà de la carte, vos propres marqueurs de
jeton, et un tchat qui ne se marche plus sur les pieds. Chaque outil s'allume et
s'éteint séparément. Rien ne s'active tout seul.
</div>

<div class="vttk-paquets" markdown>

<div class="vttk-paquet" markdown>
### Firefox <span class="etat signe">signé par Mozilla</span>

S'installe d'un clic et reste installé. Firefox vérifie la signature à
l'ouverture du fichier ; il n'y a rien à régler et rien à réactiver à chaque
démarrage.

[Télécharger le .xpi](vttinker-firefox.xpi){ .vttk-bouton download }
</div>

<div class="vttk-paquet" markdown>
### Chrome <span class="etat">mode développeur</span>

Chrome n'installe que ce qui vient de son magasin, ou ce qu'on lui donne à la
main. Le paquet est le même code ; il se charge en trois gestes, et il faut le
recharger si vous videz votre profil.

[Télécharger le .zip](vttinker-chrome.zip){ .vttk-bouton .creux download }
</div>

</div>

## Installer sur Firefox

<ol class="vttk-etapes" markdown>
<li markdown>**Téléchargez le fichier `.xpi`** avec le bouton ci-dessus. Firefox
propose parfois de l'ouvrir directement : c'est ce qu'on veut.</li>
<li markdown>**Si rien ne se passe**, ouvrez `about:addons`, cliquez la roue
dentée en haut à droite, puis **Installer un module depuis un fichier**, et
choisissez le `.xpi` téléchargé.</li>
<li markdown>**Acceptez la permission demandée.** Il n'y en a qu'une —
*stockage* — et elle sert à retenir vos réglages sur votre machine.</li>
<li markdown>**Ouvrez une partie Roll20.** Une section **VTTK** apparaît en bas
de la colonne d'outils, à gauche.</li>
</ol>

!!! note "Pourquoi une signature"
    Depuis Firefox 48, une extension non signée ne s'installe pas. Le paquet est
    donc envoyé à Mozilla, qui le vérifie et le signe. Il n'est pas publié sur
    leur magasin : la signature dit seulement qu'il vient bien d'ici et qu'il
    n'a pas été modifié en route.

## Installer sur Chrome

<ol class="vttk-etapes" markdown>
<li markdown>**Téléchargez le `.zip`** et **décompressez-le** dans un dossier que
vous garderez — Chrome lit le dossier à chaque démarrage, il ne le recopie
pas.</li>
<li markdown>**Ouvrez `chrome://extensions`** et activez **Mode développeur**, en
haut à droite.</li>
<li markdown>**Cliquez « Charger l'extension non empaquetée »** et désignez le
dossier décompressé — celui qui contient `manifest.json`.</li>
<li markdown>**Ouvrez une partie Roll20.** La section **VTTK** apparaît dans la
colonne d'outils.</li>
</ol>

!!! warning "Ce que le mode développeur implique"
    Chrome affiche un bandeau d'avertissement à chaque démarrage, et peut
    désactiver l'extension si vous réinitialisez votre profil. C'est le prix à
    payer pour installer une extension qui ne vient pas du Chrome Web Store —
    ce n'est pas un défaut du paquet.

## Ce qu'elle touche, et ce qu'elle ne touche pas

| | |
| --- | --- |
| **Permission demandée** | `stockage`, et rien d'autre |
| **Sites concernés** | `app.roll20.net/editor` seulement |
| **Ce qui sort de votre machine** | rien — aucun appel réseau, sauf les images de marqueurs que **vous** ajoutez |
| **Ce qu'elle écrit chez Roll20** | les marqueurs de jeton que vous posez, et rien d'autre |
| **Ce qu'elle range chez vous** | vos réglages et votre palette, dans le stockage local du navigateur |

Le code est lisible dans son intégralité sur
[GitHub](https://github.com/igneefleur/vttinker) — commentaires compris, et ils
racontent ce qui a été mesuré.
