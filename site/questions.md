# Questions

## Mes camarades doivent-ils l'installer aussi ?

**Non**, et c'est délibéré.

Un marqueur que vous posez est écrit dans la partie **comme n'importe quel
marqueur de Roll20** — c'est Roll20 qui le dessine, pas l'extension. L'étiquette
porte l'adresse de l'image, donc elle se suffit à elle-même. Tout le monde la
voit, extension ou pas.

Même chose pour les émojis : ce sont ceux d'Unicode, pas des images à nous.

Ce qui reste chez vous seul : les bornes du zoom, la grille hors carte, et la
mise en page du tchat. Ce sont des retouches de **votre** vue.

## Pourquoi Chrome demande le mode développeur ?

Parce que l'extension n'est pas publiée sur le Chrome Web Store. Chrome
n'installe d'un clic que ce qui vient de là ; tout le reste passe par
« Charger l'extension non empaquetée », qui exige le mode développeur.

Firefox, lui, accepte une extension **signée** sans passer par son magasin —
c'est pourquoi il y a un `.xpi` d'un côté et un `.zip` de l'autre.

## Qu'est-ce qui sort de ma machine ?

Rien. Il n'y a **aucun appel réseau** dans le code — ni `fetch`, ni
`XMLHttpRequest`, ni `sendBeacon`. C'est vérifiable en trois secondes sur le
dépôt, et un contrôle du banc s'en assure à chaque modification.

La seule exception est celle que vous créez vous-même : si vous ajoutez un
marqueur pointant vers une image, votre navigateur va chercher cette image, chez
l'hôte que vous avez indiqué. C'est ce que fait n'importe quelle image d'une
page web.

!!! note "Une conséquence à connaître"
    Si **quelqu'un d'autre** à votre table pose un marqueur personnalisé, votre
    navigateur ira chercher **son** image, chez **son** hôte. Cet hôte verra donc
    passer votre adresse IP — exactement comme pour n'importe quelle image
    partagée dans une partie. L'extension ne transmet aucun référent.

## Est-ce que ça ralentit Roll20 ?

Mesuré, tous outils allumés : **0,2 ms par trame**, soit 3,5 % d'un cœur, et les
images par seconde passent de 181 à 176.

Le calque de dessin ne tourne que s'il y a quelque chose à peindre. Quand tous
les outils sont éteints, il n'existe pas dans la page.

## Ça marche sur les vieilles campagnes ?

Oui. Roll20 sert deux moteurs de rendu, et les quatre outils fonctionnent sur les
deux — meneur ou joueur. Chaque combinaison a été éprouvée sur une vraie partie.

## Comment je la désinstalle ?

Par le gestionnaire de modules de votre navigateur, comme n'importe quelle
extension. Vos réglages partent avec elle.

Les marqueurs que vous avez posés sur des jetons, eux, **restent dans la
partie** : ils appartiennent à Roll20, pas à l'extension. Pour les enlever, il
faut les retirer des jetons.

## Je peux lire le code ?

Oui, en entier —
[github.com/igneefleur/vttinker](https://github.com/igneefleur/vttinker).

Il est en français, commentaires compris, et les commentaires ne redisent pas ce
que le code fait : ils racontent ce qui a été **mesuré**, ce qui a échoué, et
pourquoi telle solution a été écartée.

Le code est lisible ; il n'est pas libre de droits.
