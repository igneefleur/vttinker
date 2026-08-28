/* LES ÉMOJIS — un catalogue, et rien d'autre.
 *
 * LA CONTRAINTE COMMANDE TOUT LE RESTE : « des émojis que tout le monde peut
 * voir, même ceux sans l'extension ». Elle écarte d'un coup l'idée d'émojis
 * maison — une image servie par nous n'existerait que chez nous, et le message
 * arriverait troué chez les autres.
 *
 * Ce qui traverse, c'est du TEXTE. Un émoji Unicode part dans le message comme
 * une lettre : Roll20 le stocke, le rediffuse, l'affiche, et chaque poste le
 * dessine avec sa propre police. Personne n'a besoin de rien installer.
 *
 * ---------------------------------------------------------------------------
 * LES CATÉGORIES SONT CELLES D'UNICODE, ET PAS LES NÔTRES.
 *
 * Le premier jet les avait improvisées, avec une catégorie « À la table » qui
 * n'existe dans aucune norme et qui piochait dans SEPT groupes officiels à la
 * fois. C'était défendable — le dé et le dragon servent plus qu'un taxi sur
 * Roll20 — mais c'était un classement de plus à apprendre, et il était le seul
 * à le connaître.
 *
 * Ce sont désormais les huit groupes d'UTS #51, dans l'ordre du fichier, et
 * chaque émoji est dans le sien : les cœurs chez « Visages et émotions » (ce
 * sont des émotions), la météo chez « Voyage et lieux », les enseignes de
 * cartes chez « Activités ». Le catalogue est ENGENDRÉ depuis la table, pas
 * rangé à la main ; seuls les noms français sont écrits ici.
 *
 * LE GROUPE « FLAGS » EST LE SEUL ABSENT, et c'est la règle 1 ci-dessous qui
 * l'exclut : un drapeau est une paire d'indicateurs régionaux, donc une
 * séquence composée.
 * ---------------------------------------------------------------------------
 *
 * TROIS RÈGLES, et le banc d'essai les vérifie CONTRE LA SOURCE : la table
 * officielle d'UTS #51, gardée telle quelle dans outils/, avec sa notice.
 *
 * 1. AUCUNE SÉQUENCE COMPOSÉE. Un émoji d'ici tient en UN caractère, plus au
 *    besoin son sélecteur de présentation. Sont donc exclus les assemblages
 *    reliés par U+200D — les familles, les métiers genrés —, les teintes de
 *    peau et les drapeaux. Ce sont eux qui se décomposent sur un poste en
 *    retard : au lieu d'un dessin, le lecteur reçoit deux ou trois dessins à la
 *    suite, et le message dit autre chose que ce qu'on a écrit. Un caractère
 *    simple ne peut pas se décomposer : au pire il manque, il ne ment pas.
 *
 * 2. RIEN DE PLUS RÉCENT QU'UNICODE 12 (2019). Un caractère ajouté depuis
 *    s'affiche en carré vide sur un poste qui n'a pas suivi. Six ans de recul,
 *    et on est lu partout. La VRAIE vérification est au banc, qui lit la version
 *    d'apparition de chaque caractère dans la table ; le plafond ci-dessous
 *    n'est qu'un garde-fou grossier, pour ce qui sort du stockage.
 *
 * 3. LE SÉLECTEUR DE PRÉSENTATION OÙ IL FAUT — ET IL N'Y A PAS DE RÈGLE
 *    SIMPLE POUR SAVOIR OÙ.
 *
 *    Le premier jet en avait inventé une : « sous U+1F000, U+FE0F obligatoire ;
 *    au-dessus, interdit ». Elle est FAUSSE DANS LES DEUX SENS, et le contrôle
 *    l'a montré sur soixante-treize entrées. ⚡ ✨ ☕ ⛪ ✋ vivent sous le seuil
 *    et sont des émojis de naissance ; 🗡️ 🏔️ 🕷️ 🗺️ vivent au-dessus et sont des
 *    SYMBOLES, qui sans sélecteur se dessinent en noir et blanc à la taille
 *    d'une lettre.
 *
 *    Ce n'est pas une affaire d'intervalle mais une propriété par caractère.
 *    On ne la devine donc plus : la table le dit — un caractère mal composé y
 *    est « minimally-qualified » —, et le PILOTE peint les émojis dans un vrai
 *    navigateur pour signaler ceux qui sortent en gris ou en carré vide.
 */

var VTT_EMOJI_RECENTS_MAX = 24;

/* LE PLAFOND EST GROSSIER, ET IL LE RESTE. U+1FA95 — le banjo — est le plus
 * haut point de code d'Unicode 12 ; au-dessus commence Unicode 13. Ce n'est
 * PAS une frontière exacte : la 13 a aussi ajouté des caractères SOUS ce
 * plafond, dans d'autres blocs. Il ne sert qu'à écarter l'aberration franche
 * dans ce qui remonte du stockage, où l'on n'a pas la table sous la main.
 * La vérification sérieuse est au banc. */
var VTT_EMOJI_PLAFOND = 0x1FA95;
var VTT_EMOJI_VS16 = "️";

/* Ce qu'on peut vérifier sans la table NI navigateur : la forme. */
function vttEmojiBienForme(car) {
  if (typeof car !== "string" || !car) { return false; }
  var pts = Array.from(car).map(function (c) { return c.codePointAt(0); });
  /* Un caractère, plus au besoin son sélecteur : rien d'autre. Cette seule
   * condition écarte toutes les séquences composées, qui font trois points de
   * code au minimum. */
  if (pts.length > 2) { return false; }
  if (pts.length === 2 && pts[1] !== 0xFE0F) { return false; }
  var p = pts[0];
  if (p >= 0x1F3FB && p <= 0x1F3FF) { return false; }   // teinte de peau
  if (p >= 0x1F1E6 && p <= 0x1F1FF) { return false; }   // moitié de drapeau
  if (p === 0x200D || p === 0x20E3) { return false; }   // liant, cercle de touche
  if (p > VTT_EMOJI_PLAFOND) { return false; }
  return true;
}

/* ---------- LE CATALOGUE ----------
 *
 * Chaque entrée est [ caractère, nom ]. Le nom sert d'infobulle : un émoji dont
 * on hésite sur le sens se choisit mal, et une grille de plusieurs centaines de
 * dessins sans un mot est un jeu de devinettes.
 *
 * « officiel » porte le nom du groupe dans la table : c'est lui que le banc
 * confronte, caractère par caractère.
 */
var VTT_EMOJIS = [
  {
    id: "visages",
    nom: "Visages et émotions",
    onglet: "😀",
    officiel: "Smileys & Emotion",
    liste: [
      ["😀", "grinning face", "sourire"], ["😃", "grinning face with big eyes", "grand sourire"], ["😄", "grinning face with smiling eyes", "sourire aux yeux plissés"],
      ["😁", "beaming face with smiling eyes", "sourire radieux"], ["😆", "grinning squinting face", "fou rire"], ["😅", "grinning face with sweat", "rire gêné"],
      ["🤣", "rolling on the floor laughing", "mort de rire"], ["😂", "face with tears of joy", "larmes de rire"], ["🙂", "slightly smiling face", "petit sourire"],
      ["🙃", "upside-down face", "tête à l'envers"], ["😉", "winking face", "clin d'œil"], ["😊", "smiling face with smiling eyes", "sourire timide"],
      ["😇", "smiling face with halo", "auréole"], ["🥰", "smiling face with hearts", "plein d'amour"], ["😍", "smiling face with heart-eyes", "yeux en cœur"],
      ["🤩", "star-struck", "yeux étoilés"], ["😘", "face blowing a kiss", "bisou"], ["😗", "kissing face", "bouche en cœur"],
      ["😙", "kissing face with smiling eyes", "bisou souriant"], ["😋", "face savoring food", "gourmand"], ["😛", "face with tongue", "tire la langue"],
      ["😜", "winking face with tongue", "langue et clin d'œil"], ["🤪", "zany face", "cinglé"], ["😝", "squinting face with tongue", "langue et yeux fermés"],
      ["🤑", "money-mouth face", "appât du gain"], ["🤗", "smiling face with open hands", "câlin"], ["🤭", "face with hand over mouth", "main sur la bouche"],
      ["🤫", "shushing face", "chut"], ["🤔", "thinking face", "réfléchit"], ["🤐", "zipper-mouth face", "bouche cousue"],
      ["🤨", "face with raised eyebrow", "sourcil levé"], ["😐", "neutral face", "neutre"], ["😑", "expressionless face", "sans expression"],
      ["😶", "face without mouth", "sans bouche"], ["😏", "smirking face", "narquois"], ["😒", "unamused face", "pas convaincu"],
      ["🙄", "face with rolling eyes", "lève les yeux au ciel"], ["😬", "grimacing face", "grimace"], ["🤥", "lying face", "menteur"],
      ["😌", "relieved face", "soulagé"], ["😔", "pensive face", "pensif"], ["😪", "sleepy face", "somnolent"],
      ["🤤", "drooling face", "bave"], ["😴", "sleeping face", "dort"], ["😷", "face with medical mask", "masque"],
      ["🤒", "face with thermometer", "fiévreux"], ["🤕", "face with head-bandage", "blessé"], ["🤢", "nauseated face", "nauséeux"],
      ["🤮", "face vomiting", "vomit"], ["🤧", "sneezing face", "éternue"], ["🥵", "hot face", "a très chaud"],
      ["🥶", "cold face", "a très froid"], ["🥴", "woozy face", "étourdi"], ["😵", "face with crossed-out eyes", "K.-O."],
      ["🤯", "exploding head", "tête qui explose"], ["🤠", "cowboy hat face", "chapeau de cow-boy"], ["🥳", "partying face", "fait la fête"],
      ["😎", "smiling face with sunglasses", "lunettes de soleil"], ["🤓", "nerd face", "binoclard"], ["🧐", "face with monocle", "monocle"],
      ["😕", "confused face", "perplexe"], ["😟", "worried face", "inquiet"], ["🙁", "slightly frowning face", "légère moue"],
      ["☹️", "frowning face", "moue"], ["😮", "face with open mouth", "bouche ouverte"], ["😯", "hushed face", "interloqué"],
      ["😲", "astonished face", "stupéfait"], ["😳", "flushed face", "rougit"], ["🥺", "pleading face", "yeux implorants"],
      ["😦", "frowning face with open mouth", "consterné"], ["😧", "anguished face", "angoissé"], ["😨", "fearful face", "apeuré"],
      ["😰", "anxious face with sweat", "sueur froide"], ["😥", "sad but relieved face", "triste mais soulagé"], ["😢", "crying face", "pleure"],
      ["😭", "loudly crying face", "sanglote"], ["😱", "face screaming in fear", "hurle de peur"], ["😖", "confounded face", "exaspéré"],
      ["😣", "persevering face", "persévère"], ["😞", "disappointed face", "déçu"], ["😓", "downcast face with sweat", "accablé"],
      ["😩", "weary face", "épuisé"], ["😫", "tired face", "las"], ["🥱", "yawning face", "bâille"],
      ["😤", "face with steam from nose", "triomphant"], ["😡", "enraged face", "furieux"], ["😠", "angry face", "en colère"],
      ["🤬", "face with symbols on mouth", "jure"], ["😈", "smiling face with horns", "diable espiègle"], ["👿", "angry face with horns", "diable en colère"],
      ["💀", "skull", "crâne"], ["☠️", "skull and crossbones", "tête de mort"], ["💩", "pile of poo", "crotte"],
      ["🤡", "clown face", "clown"], ["👹", "ogre", "ogre"], ["👺", "goblin", "tengu"],
      ["👻", "ghost", "fantôme"], ["👽", "alien", "alien"], ["🤖", "robot", "robot"],
      ["🙈", "see-no-evil monkey", "ne rien voir"], ["🙉", "hear-no-evil monkey", "ne rien entendre"], ["🙊", "speak-no-evil monkey", "ne rien dire"],
      ["💘", "heart with arrow", "cœur transpercé"], ["💝", "heart with ribbon", "cœur-cadeau"], ["💖", "sparkling heart", "cœur scintillant"],
      ["💗", "growing heart", "cœur grandissant"], ["💓", "beating heart", "cœur qui bat"], ["💞", "revolving hearts", "cœurs qui tournent"],
      ["💕", "two hearts", "deux cœurs"], ["❣️", "heart exclamation", "exclamation en cœur"], ["💔", "broken heart", "cœur brisé"],
      ["❤️", "red heart", "cœur rouge"], ["🧡", "orange heart", "cœur orange"], ["💛", "yellow heart", "cœur jaune"],
      ["💚", "green heart", "cœur vert"], ["💙", "blue heart", "cœur bleu"], ["💜", "purple heart", "cœur violet"],
      ["🤎", "brown heart", "cœur brun"], ["🖤", "black heart", "cœur noir"], ["🤍", "white heart", "cœur blanc"],
      ["💥", "collision", "explosion"]
    ]
  },
  {
    id: "gens",
    nom: "Gens et gestes",
    onglet: "👋",
    officiel: "People & Body",
    liste: [
      ["👋", "waving hand", "coucou"], ["🤚", "raised back of hand", "dos de la main"], ["🖐️", "hand with fingers splayed", "main doigts écartés"],
      ["✋", "raised hand", "main levée"], ["🖖", "vulcan salute", "salut vulcain"], ["👌", "OK hand", "parfait"],
      ["✌️", "victory hand", "victoire"], ["🤞", "crossed fingers", "doigts croisés"], ["🤟", "love-you gesture", "je t'aime"],
      ["🤘", "sign of the horns", "cornes"], ["🤙", "call me hand", "appelle-moi"], ["👈", "backhand index pointing left", "pointe à gauche"],
      ["👉", "backhand index pointing right", "pointe à droite"], ["👆", "backhand index pointing up", "pointe en haut"], ["👇", "backhand index pointing down", "pointe en bas"],
      ["☝️", "index pointing up", "index levé"], ["👍", "thumbs up", "pouce en l'air"], ["👎", "thumbs down", "pouce en bas"],
      ["✊", "raised fist", "poing levé"], ["👊", "oncoming fist", "coup de poing"], ["🤛", "left-facing fist", "poing à gauche"],
      ["🤜", "right-facing fist", "poing à droite"], ["👏", "clapping hands", "applaudit"], ["🙌", "raising hands", "bras levés"],
      ["👐", "open hands", "mains ouvertes"], ["🤲", "palms up together", "paumes jointes"], ["🤝", "handshake", "poignée de main"],
      ["🙏", "folded hands", "prière"], ["💪", "flexed biceps", "biceps"], ["🧠", "brain", "cerveau"],
      ["🦷", "tooth", "dent"], ["🦴", "bone", "os"], ["👀", "eyes", "yeux"],
      ["👁️", "eye", "œil"], ["👅", "tongue", "langue"], ["👄", "mouth", "bouche"],
      ["👶", "baby", "bébé"], ["🧒", "child", "enfant"], ["🧑", "person", "personne"],
      ["👨", "man", "homme"], ["👩", "woman", "femme"], ["🧓", "older person", "personne âgée"],
      ["🙅", "person gesturing NO", "geste de refus"], ["🙆", "person gesturing OK", "geste d'accord"], ["💁", "person tipping hand", "renseigne"],
      ["🙋", "person raising hand", "lève la main"], ["🙇", "person bowing", "s'incline"], ["🤦", "person facepalming", "main sur le front"],
      ["🤷", "person shrugging", "hausse les épaules"], ["👮", "police officer", "policier"], ["🕵️", "detective", "détective"],
      ["💂", "guard", "garde"], ["👷", "construction worker", "ouvrier"], ["🤴", "prince", "prince"],
      ["👸", "princess", "princesse"], ["🧕", "woman with headscarf", "personne au foulard"], ["🤵", "person in tuxedo", "en smoking"],
      ["👰", "person with veil", "en voile"], ["🎅", "Santa Claus", "père Noël"], ["🦸", "superhero", "héros"],
      ["🦹", "supervillain", "vilain"], ["🧙", "mage", "mage"], ["🧚", "fairy", "fée"],
      ["🧛", "vampire", "vampire"], ["🧜", "merperson", "sirène"], ["🧝", "elf", "elfe"],
      ["🧞", "genie", "génie"], ["🧟", "zombie", "zombie"], ["🚶", "person walking", "marche"],
      ["🏃", "person running", "court"], ["💃", "woman dancing", "danseuse"], ["🕺", "man dancing", "danseur"],
      ["🧘", "person in lotus position", "médite"]
    ]
  },
  {
    id: "nature",
    nom: "Animaux et nature",
    onglet: "🐻",
    officiel: "Animals & Nature",
    liste: [
      ["🐵", "monkey face", "singe"], ["🦍", "gorilla", "gorille"], ["🐶", "dog face", "chien"],
      ["🐺", "wolf", "loup"], ["🦊", "fox", "renard"], ["🐱", "cat face", "chat"],
      ["🦁", "lion", "lion"], ["🐯", "tiger face", "tigre"], ["🐆", "leopard", "léopard"],
      ["🐴", "horse face", "cheval"], ["🦄", "unicorn", "licorne"], ["🦓", "zebra", "zèbre"],
      ["🦌", "deer", "cerf"], ["🐮", "cow face", "vache"], ["🐷", "pig face", "cochon"],
      ["🐗", "boar", "sanglier"], ["🐑", "ewe", "mouton"], ["🐐", "goat", "chèvre"],
      ["🐪", "camel", "dromadaire"], ["🦒", "giraffe", "girafe"], ["🐘", "elephant", "éléphant"],
      ["🦏", "rhinoceros", "rhinocéros"], ["🐭", "mouse face", "souris"], ["🐹", "hamster", "hamster"],
      ["🐰", "rabbit face", "lapin"], ["🐇", "rabbit", "lièvre"], ["🐿️", "chipmunk", "écureuil"],
      ["🦇", "bat", "chauve-souris"], ["🐻", "bear", "ours"], ["🐨", "koala", "koala"],
      ["🐼", "panda", "panda"], ["🐔", "chicken", "poule"], ["🐦", "bird", "oiseau"],
      ["🐧", "penguin", "manchot"], ["🦅", "eagle", "aigle"], ["🦆", "duck", "canard"],
      ["🦉", "owl", "hibou"], ["🐸", "frog", "grenouille"], ["🐊", "crocodile", "crocodile"],
      ["🐢", "turtle", "tortue"], ["🦎", "lizard", "lézard"], ["🐍", "snake", "serpent"],
      ["🐲", "dragon face", "tête de dragon"], ["🐉", "dragon", "dragon"], ["🐳", "spouting whale", "baleine"],
      ["🐬", "dolphin", "dauphin"], ["🐟", "fish", "poisson"], ["🐠", "tropical fish", "poisson tropical"],
      ["🦈", "shark", "requin"], ["🐙", "octopus", "pieuvre"], ["🦀", "crab", "crabe"],
      ["🦑", "squid", "calmar"], ["🐌", "snail", "escargot"], ["🦋", "butterfly", "papillon"],
      ["🐛", "bug", "chenille"], ["🐜", "ant", "fourmi"], ["🐝", "honeybee", "abeille"],
      ["🐞", "lady beetle", "coccinelle"], ["🕷️", "spider", "araignée"], ["🕸️", "spider web", "toile"],
      ["🦂", "scorpion", "scorpion"], ["💐", "bouquet", "bouquet"], ["🌸", "cherry blossom", "fleur de cerisier"],
      ["🌹", "rose", "rose"], ["🌻", "sunflower", "tournesol"], ["🌼", "blossom", "marguerite"],
      ["🌷", "tulip", "tulipe"], ["🌲", "evergreen tree", "sapin"], ["🌳", "deciduous tree", "arbre"],
      ["🌴", "palm tree", "palmier"], ["🌵", "cactus", "cactus"], ["🌿", "herb", "herbe"],
      ["☘️", "shamrock", "trèfle"], ["🍀", "four leaf clover", "trèfle à quatre feuilles"], ["🍁", "maple leaf", "feuille d'érable"],
      ["🍂", "fallen leaf", "feuilles mortes"], ["🍃", "leaf fluttering in wind", "feuille au vent"], ["🍄", "mushroom", "champignon"]
    ]
  },
  {
    id: "nourriture",
    nom: "Nourriture et boissons",
    onglet: "🍔",
    officiel: "Food & Drink",
    liste: [
      ["🍇", "grapes", "raisin"], ["🍉", "watermelon", "pastèque"], ["🍊", "tangerine", "orange"],
      ["🍋", "lemon", "citron"], ["🍌", "banana", "banane"], ["🍍", "pineapple", "ananas"],
      ["🥭", "mango", "mangue"], ["🍎", "red apple", "pomme"], ["🍐", "pear", "poire"],
      ["🍑", "peach", "pêche"], ["🍒", "cherries", "cerises"], ["🍓", "strawberry", "fraise"],
      ["🥝", "kiwi fruit", "kiwi"], ["🍅", "tomato", "tomate"], ["🥥", "coconut", "noix de coco"],
      ["🥑", "avocado", "avocat"], ["🍆", "eggplant", "aubergine"], ["🥔", "potato", "pomme de terre"],
      ["🥕", "carrot", "carotte"], ["🌽", "ear of corn", "maïs"], ["🌶️", "hot pepper", "piment"],
      ["🥒", "cucumber", "concombre"], ["🥬", "leafy green", "salade"], ["🥦", "broccoli", "brocoli"],
      ["🧄", "garlic", "ail"], ["🧅", "onion", "oignon"], ["🥜", "peanuts", "cacahuètes"],
      ["🌰", "chestnut", "châtaigne"], ["🍞", "bread", "pain"], ["🥐", "croissant", "croissant"],
      ["🥖", "baguette bread", "baguette"], ["🥨", "pretzel", "bretzel"], ["🥞", "pancakes", "crêpes"],
      ["🧀", "cheese wedge", "fromage"], ["🍖", "meat on bone", "viande sur l'os"], ["🍗", "poultry leg", "cuisse de volaille"],
      ["🥩", "cut of meat", "viande"], ["🥓", "bacon", "lard"], ["🍔", "hamburger", "hamburger"],
      ["🍟", "french fries", "frites"], ["🍕", "pizza", "pizza"], ["🌭", "hot dog", "hot-dog"],
      ["🥪", "sandwich", "sandwich"], ["🌮", "taco", "taco"], ["🌯", "burrito", "burrito"],
      ["🥚", "egg", "œuf"], ["🍳", "cooking", "œuf au plat"], ["🥘", "shallow pan of food", "plat mijoté"],
      ["🍲", "pot of food", "marmite"], ["🥗", "green salad", "salade composée"], ["🍿", "popcorn", "pop-corn"],
      ["🧈", "butter", "beurre"], ["🍱", "bento box", "bento"], ["🍙", "rice ball", "boulette de riz"],
      ["🍚", "cooked rice", "riz"], ["🍛", "curry rice", "curry"], ["🍜", "steaming bowl", "nouilles"],
      ["🍝", "spaghetti", "pâtes"], ["🍣", "sushi", "sushi"], ["🍤", "fried shrimp", "beignet de crevette"],
      ["🥟", "dumpling", "raviolis"], ["🍦", "soft ice cream", "glace à l'italienne"], ["🍧", "shaved ice", "granité"],
      ["🍨", "ice cream", "glace en coupe"], ["🍩", "doughnut", "beignet"], ["🍪", "cookie", "biscuit"],
      ["🎂", "birthday cake", "gâteau d'anniversaire"], ["🍰", "shortcake", "part de gâteau"], ["🧁", "cupcake", "cupcake"],
      ["🥧", "pie", "tarte"], ["🍫", "chocolate bar", "chocolat"], ["🍬", "candy", "bonbon"],
      ["🍭", "lollipop", "sucette"], ["🍮", "custard", "flan"], ["🍯", "honey pot", "miel"],
      ["🥛", "glass of milk", "lait"], ["☕", "hot beverage", "café"], ["🍵", "teacup without handle", "thé"],
      ["🍶", "sake", "saké"], ["🍾", "bottle with popping cork", "champagne"], ["🍷", "wine glass", "vin"],
      ["🍸", "cocktail glass", "cocktail"], ["🍹", "tropical drink", "cocktail tropical"], ["🍺", "beer mug", "bière"],
      ["🍻", "clinking beer mugs", "chopes"], ["🥂", "clinking glasses", "trinque"], ["🥃", "tumbler glass", "alcool fort"],
      ["🧊", "ice", "glaçon"], ["🥄", "spoon", "cuillère"]
    ]
  },
  {
    id: "lieux",
    nom: "Voyage et lieux",
    onglet: "✈️",
    officiel: "Travel & Places",
    liste: [
      ["🗺️", "world map", "carte"], ["🧭", "compass", "boussole"], ["🏔️", "snow-capped mountain", "montagne enneigée"],
      ["⛰️", "mountain", "montagne"], ["🌋", "volcano", "volcan"], ["🗻", "mount fuji", "mont Fuji"],
      ["🏕️", "camping", "camping"], ["🏖️", "beach with umbrella", "plage"], ["🏜️", "desert", "désert"],
      ["🏝️", "desert island", "île déserte"], ["🏞️", "national park", "parc naturel"], ["🏟️", "stadium", "stade"],
      ["🏛️", "classical building", "temple antique"], ["🏗️", "building construction", "chantier"], ["🏘️", "houses", "quartier"],
      ["🏚️", "derelict house", "maison abandonnée"], ["🏠", "house", "maison"], ["🏡", "house with garden", "maison avec jardin"],
      ["🏢", "office building", "immeuble de bureaux"], ["🏥", "hospital", "hôpital"], ["🏦", "bank", "banque"],
      ["🏨", "hotel", "hôtel"], ["🏪", "convenience store", "supérette"], ["🏫", "school", "école"],
      ["🏬", "department store", "grand magasin"], ["🏭", "factory", "usine"], ["🏯", "Japanese castle", "château japonais"],
      ["🏰", "castle", "château"], ["🗼", "Tokyo tower", "tour de Tokyo"], ["🗽", "Statue of Liberty", "statue de la Liberté"],
      ["⛪", "church", "église"], ["🕌", "mosque", "mosquée"], ["🕍", "synagogue", "synagogue"],
      ["⛩️", "shinto shrine", "torii"], ["⛺", "tent", "tente"], ["🌁", "foggy", "brouillard"],
      ["🌃", "night with stars", "nuit étoilée"], ["🏙️", "cityscape", "ville"], ["🌄", "sunrise over mountains", "lever de soleil sur les montagnes"],
      ["🌅", "sunrise", "lever de soleil"], ["🌇", "sunset", "coucher de soleil"], ["🌉", "bridge at night", "pont de nuit"],
      ["🎠", "carousel horse", "manège"], ["🎡", "ferris wheel", "grande roue"], ["🎢", "roller coaster", "montagnes russes"],
      ["🎪", "circus tent", "chapiteau"], ["🚂", "locomotive", "locomotive"], ["🚆", "train", "train"],
      ["🚇", "metro", "métro"], ["🚌", "bus", "bus"], ["🚕", "taxi", "taxi"],
      ["🚗", "automobile", "voiture"], ["🚙", "sport utility vehicle", "tout-terrain"], ["🚚", "delivery truck", "camion"],
      ["🚜", "tractor", "tracteur"], ["🏎️", "racing car", "voiture de course"], ["🏍️", "motorcycle", "moto"],
      ["🚲", "bicycle", "vélo"], ["⚓", "anchor", "ancre"], ["⛵", "sailboat", "voilier"],
      ["🚤", "speedboat", "hors-bord"], ["🛳️", "passenger ship", "paquebot"], ["✈️", "airplane", "avion"],
      ["🚁", "helicopter", "hélicoptère"], ["🚀", "rocket", "fusée"], ["🛸", "flying saucer", "soucoupe"],
      ["🌙", "crescent moon", "croissant de lune"], ["☀️", "sun", "soleil"], ["🌟", "glowing star", "étoile brillante"],
      ["🌌", "milky way", "voie lactée"], ["☁️", "cloud", "nuage"], ["⛅", "sun behind cloud", "éclaircie"],
      ["⛈️", "cloud with lightning and rain", "orage"], ["🌧️", "cloud with rain", "pluie"], ["🌈", "rainbow", "arc-en-ciel"],
      ["⚡", "high voltage", "éclair"], ["❄️", "snowflake", "flocon"], ["🔥", "fire", "feu"],
      ["🌊", "water wave", "vague"]
    ]
  },
  {
    id: "activites",
    nom: "Activités",
    onglet: "⚽",
    officiel: "Activities",
    liste: [
      ["🎃", "jack-o-lantern", "citrouille d'Halloween"], ["🎄", "Christmas tree", "sapin de Noël"], ["🎆", "fireworks", "feu d'artifice"],
      ["🎇", "sparkler", "cierge magique"], ["🧨", "firecracker", "pétard"], ["✨", "sparkles", "étincelles"],
      ["🎈", "balloon", "ballon"], ["🎉", "party popper", "cotillon"], ["🎊", "confetti ball", "boule de confettis"],
      ["🎋", "tanabata tree", "arbre de Tanabata"], ["🎍", "pine decoration", "décoration de pin"], ["🎎", "Japanese dolls", "poupées japonaises"],
      ["🎏", "carp streamer", "manche à air carpe"], ["🎐", "wind chime", "carillon à vent"], ["🎑", "moon viewing ceremony", "contemplation de la lune"],
      ["🧧", "red envelope", "enveloppe rouge"], ["🎀", "ribbon", "nœud"], ["🎁", "wrapped gift", "cadeau"],
      ["🎗️", "reminder ribbon", "ruban de soutien"], ["🎟️", "admission tickets", "billets d'entrée"], ["🎫", "ticket", "ticket"],
      ["🎖️", "military medal", "médaille militaire"], ["🏆", "trophy", "trophée"], ["🏅", "sports medal", "médaille sportive"],
      ["🥇", "1st place medal", "médaille d'or"], ["🥈", "2nd place medal", "médaille d'argent"], ["🥉", "3rd place medal", "médaille de bronze"],
      ["⚽", "soccer ball", "ballon de football"], ["⚾", "baseball", "baseball"], ["🥎", "softball", "softball"],
      ["🏀", "basketball", "basket-ball"], ["🏐", "volleyball", "volley-ball"], ["🏈", "american football", "football américain"],
      ["🏉", "rugby football", "rugby"], ["🎾", "tennis", "tennis"], ["🥏", "flying disc", "disque volant"],
      ["🎳", "bowling", "bowling"], ["🏏", "cricket game", "cricket"], ["🏑", "field hockey", "hockey sur gazon"],
      ["🏒", "ice hockey", "hockey sur glace"], ["🥍", "lacrosse", "crosse"], ["🏓", "ping pong", "tennis de table"],
      ["🏸", "badminton", "badminton"], ["🥊", "boxing glove", "gant de boxe"], ["🥋", "martial arts uniform", "kimono"],
      ["🥅", "goal net", "cage de but"], ["⛳", "flag in hole", "trou de golf"], ["⛸️", "ice skate", "patin à glace"],
      ["🎣", "fishing pole", "canne à pêche"], ["🤿", "diving mask", "masque de plongée"], ["🎽", "running shirt", "maillot de course"],
      ["🎿", "skis", "skis"], ["🛷", "sled", "luge"], ["🥌", "curling stone", "pierre de curling"],
      ["🎯", "bullseye", "cible"], ["🪀", "yo-yo", "yoyo"], ["🪁", "kite", "cerf-volant"],
      ["🔫", "water pistol", "pistolet à eau"], ["🎱", "pool 8 ball", "boule de billard"], ["🔮", "crystal ball", "boule de cristal"],
      ["🎮", "video game", "manette de jeu"], ["🕹️", "joystick", "manche à balai"], ["🎰", "slot machine", "machine à sous"],
      ["🎲", "game die", "dé"], ["🧩", "puzzle piece", "pièce de puzzle"], ["🧸", "teddy bear", "ours en peluche"],
      ["♠️", "spade suit", "pique"], ["♥️", "heart suit", "cœur"], ["♦️", "diamond suit", "carreau"],
      ["♣️", "club suit", "trèfle"], ["♟️", "chess pawn", "pion"], ["🃏", "joker", "joker"],
      ["🀄", "mahjong red dragon", "dragon rouge de mahjong"], ["🎴", "flower playing cards", "cartes à fleurs"], ["🎭", "performing arts", "arts du spectacle"],
      ["🖼️", "framed picture", "tableau"], ["🎨", "artist palette", "palette de peintre"], ["🧵", "thread", "fil"],
      ["🧶", "yarn", "pelote de laine"]
    ]
  },
  {
    id: "objets",
    nom: "Objets",
    onglet: "💡",
    officiel: "Objects",
    liste: [
      ["👑", "crown", "couronne"], ["💎", "gem stone", "gemme"], ["🔇", "muted speaker", "muet"],
      ["🔊", "speaker high volume", "haut-parleur"], ["📢", "loudspeaker", "porte-voix"], ["🔔", "bell", "cloche"],
      ["🎵", "musical note", "note"], ["🎶", "musical notes", "notes"], ["🎤", "microphone", "micro"],
      ["🎧", "headphone", "casque"], ["🎺", "trumpet", "trompette"], ["🎸", "guitar", "guitare"],
      ["🎹", "musical keyboard", "piano"], ["🎻", "violin", "violon"], ["🥁", "drum", "tambour"],
      ["📱", "mobile phone", "téléphone"], ["💻", "laptop", "ordinateur portable"], ["🖥️", "desktop computer", "ordinateur"],
      ["⌨️", "keyboard", "clavier"], ["🖱️", "computer mouse", "souris"], ["💾", "floppy disk", "disquette"],
      ["🎥", "movie camera", "caméra"], ["🎬", "clapper board", "clap"], ["📷", "camera", "appareil photo"],
      ["🕯️", "candle", "bougie"], ["💡", "light bulb", "ampoule"], ["🔦", "flashlight", "lampe torche"],
      ["📕", "closed book", "livre fermé"], ["📖", "open book", "livre ouvert"], ["📚", "books", "livres"],
      ["📓", "notebook", "carnet"], ["📃", "page with curl", "page"], ["📜", "scroll", "parchemin"],
      ["📰", "newspaper", "journal"], ["🔖", "bookmark", "marque-page"], ["🏷️", "label", "étiquette"],
      ["💰", "money bag", "sac d'or"], ["💴", "yen banknote", "billets"], ["💸", "money with wings", "argent qui s'envole"],
      ["💳", "credit card", "carte bancaire"], ["🧾", "receipt", "reçu"], ["✉️", "envelope", "enveloppe"],
      ["📧", "e-mail", "courriel"], ["📦", "package", "colis"], ["📫", "closed mailbox with raised flag", "boîte aux lettres"],
      ["📮", "postbox", "boîte postale"], ["🗳️", "ballot box with ballot", "urne"], ["✏️", "pencil", "crayon"],
      ["✒️", "black nib", "plume"], ["🖋️", "fountain pen", "stylo plume"], ["🖊️", "pen", "stylo"],
      ["🖌️", "paintbrush", "pinceau"], ["🖍️", "crayon", "craie grasse"], ["📝", "memo", "prendre des notes"],
      ["📁", "file folder", "dossier"], ["📅", "calendar", "calendrier"], ["📈", "chart increasing", "courbe en hausse"],
      ["📉", "chart decreasing", "courbe en baisse"], ["📊", "bar chart", "histogramme"], ["📋", "clipboard", "presse-papiers"],
      ["📌", "pushpin", "punaise"], ["📍", "round pushpin", "épingle"], ["📎", "paperclip", "trombone"],
      ["📏", "straight ruler", "règle"], ["📐", "triangular ruler", "équerre"], ["✂️", "scissors", "ciseaux"],
      ["🗑️", "wastebasket", "corbeille"], ["🔒", "locked", "cadenas fermé"], ["🔓", "unlocked", "cadenas ouvert"],
      ["🔐", "locked with key", "cadenas et clé"], ["🔑", "key", "clé"], ["🗝️", "old key", "clé ancienne"],
      ["🔨", "hammer", "marteau"], ["⛏️", "pick", "pioche"], ["⚒️", "hammer and pick", "marteau et pioche"],
      ["🗡️", "dagger", "dague"], ["⚔️", "crossed swords", "épées croisées"], ["🏹", "bow and arrow", "arc"],
      ["🛡️", "shield", "bouclier"], ["🔧", "wrench", "clé plate"], ["🔩", "nut and bolt", "écrou et boulon"],
      ["⚙️", "gear", "engrenage"], ["🗜️", "clamp", "étau"], ["⚖️", "balance scale", "balance"],
      ["🔗", "link", "maillon"], ["⛓️", "chains", "chaînes"], ["🧰", "toolbox", "boîte à outils"],
      ["🧲", "magnet", "aimant"], ["⚗️", "alembic", "alambic"], ["🧪", "test tube", "fiole"],
      ["🧫", "petri dish", "boîte de Petri"], ["🧬", "dna", "ADN"], ["🔬", "microscope", "microscope"],
      ["🔭", "telescope", "télescope"], ["📡", "satellite antenna", "antenne"], ["💉", "syringe", "seringue"],
      ["🩸", "drop of blood", "goutte de sang"], ["💊", "pill", "gélule"], ["🩹", "adhesive bandage", "pansement"],
      ["🩺", "stethoscope", "stéthoscope"], ["🚪", "door", "porte"], ["🛏️", "bed", "lit"],
      ["🛋️", "couch and lamp", "canapé"], ["🚿", "shower", "douche"], ["🛁", "bathtub", "baignoire"],
      ["🧴", "lotion bottle", "flacon"], ["🧷", "safety pin", "épingle à nourrice"], ["🧹", "broom", "balai"],
      ["🧺", "basket", "panier"], ["🧻", "roll of paper", "papier"], ["🧼", "soap", "savon"],
      ["🧯", "fire extinguisher", "extincteur"], ["🛒", "shopping cart", "chariot"], ["⚰️", "coffin", "cercueil"],
      ["⚱️", "funeral urn", "urne funéraire"], ["🧿", "nazar amulet", "œil protecteur"], ["🗿", "moai", "moaï"]
    ]
  },
  {
    id: "symboles",
    nom: "Symboles",
    onglet: "🔣",
    officiel: "Symbols",
    liste: [
      ["⚠️", "warning", "attention"], ["🚸", "children crossing", "enfants"], ["☢️", "radioactive", "radioactif"],
      ["☣️", "biohazard", "biologique"], ["🔚", "END arrow", "fin"], ["🔜", "SOON arrow", "bientôt"],
      ["⚛️", "atom symbol", "atome"], ["🕉️", "om", "om"], ["✡️", "star of David", "étoile de David"],
      ["☸️", "wheel of dharma", "roue du dharma"], ["☯️", "yin yang", "yin et yang"], ["✝️", "latin cross", "croix latine"],
      ["☪️", "star and crescent", "croissant et étoile"], ["☮️", "peace symbol", "paix"], ["♈", "Aries", "bélier"],
      ["♉", "Taurus", "taureau"], ["♊", "Gemini", "gémeaux"], ["♋", "Cancer", "cancer"],
      ["♌", "Leo", "lion"], ["♍", "Virgo", "vierge"], ["♎", "Libra", "balance"],
      ["♏", "Scorpio", "scorpion"], ["♐", "Sagittarius", "sagittaire"], ["♑", "Capricorn", "capricorne"],
      ["♒", "Aquarius", "verseau"], ["♓", "Pisces", "poissons"], ["✖️", "multiply", "multiplié"],
      ["➕", "plus", "plus"], ["➖", "minus", "moins"], ["➗", "divide", "divisé"],
      ["♾️", "infinity", "infini"], ["‼️", "double exclamation mark", "double exclamation"], ["⁉️", "exclamation question mark", "exclamation et interrogation"],
      ["❓", "red question mark", "point d'interrogation"], ["❗", "red exclamation mark", "point d'exclamation"], ["♻️", "recycling symbol", "recyclage"],
      ["⚜️", "fleur-de-lis", "fleur de lys"], ["🔱", "trident emblem", "trident"], ["🔰", "Japanese symbol for beginner", "débutant"],
      ["⭕", "hollow red circle", "cercle rouge"], ["✅", "check mark button", "coche verte"], ["☑️", "check box with check", "case cochée"],
      ["✔️", "check mark", "coche"], ["❌", "cross mark", "croix"], ["✳️", "eight-spoked asterisk", "astérisque"],
      ["❇️", "sparkle", "étincelle"], ["™️", "trade mark", "marque déposée"], ["🔴", "red circle", "rond rouge"],
      ["🟠", "orange circle", "rond orange"], ["🟡", "yellow circle", "rond jaune"], ["🟢", "green circle", "rond vert"],
      ["🔵", "blue circle", "rond bleu"], ["🟣", "purple circle", "rond violet"], ["⚫", "black circle", "rond noir"],
      ["⚪", "white circle", "rond blanc"], ["🔶", "large orange diamond", "losange orange"], ["🔷", "large blue diamond", "losange bleu"],
      ["🔺", "red triangle pointed up", "triangle rouge"], ["🔻", "red triangle pointed down", "triangle inversé"], ["💠", "diamond with a dot", "losange"],
      ["🔘", "radio button", "bouton rond"]
    ]
  }
];

/* LE NOM D'UN ÉMOJI, DANS LA LANGUE EN VIGUEUR.
 *
 * Chaque entrée porte [ caractère, nom anglais, nom français ]. L'anglais n'est
 * pas traduit à la main : il est LU dans emoji-test.txt, la même table qui
 * décide du groupe et de l'ordre. Une seule source, donc jamais un nom qui
 * désigne autre chose que ce que la table désigne.
 *
 * Le français, lui, est écrit — c'est la seule chose de ce fichier qui le
 * soit. */
function vttEmojiNom(entree, langue) {
  if (!entree) { return ""; }
  return (vttLangueValide(langue) === "fr" ? entree[2] : entree[1]) || entree[1] || "";
}
