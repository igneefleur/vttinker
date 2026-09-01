# Features

Five tools, each with its own switch in the **VTTK** section of the toolbar.

<div class="vttk-modules" markdown>

<div class="vttk-module" markdown>
### Zoom range

Roll20 stops at 10% and 250%. Set your own minimum and maximum. The mouse wheel,
the buttons and the slider all respect them.

Inside Roll20's own range nothing is intercepted. Past it, the step size matches
Roll20's last step, so the transition is not noticeable.
</div>

<div class="vttk-module" markdown>
### Grid beyond the page

Roll20 stops drawing the grid at the page edge. This continues it for a chosen
number of cells, aligned with the existing grid.

All five grid types work: square, hex by column, hex by row, isometric,
dimetric. Roll20's own drawing code is reused rather than reimplemented.
</div>

<div class="vttk-module" markdown>
### Custom markers

Roll20 ships 47 token status markers. Add your own with any image URL.

Other players see them without installing anything. The marker is written to the
game as a normal status marker, with the image address in the tag, so Roll20
draws it for everyone.

Markers can be applied to several tokens at once, carry a counter, and are
reorderable by drag.
</div>

<div class="vttk-module" markdown>
### Tokens off the map

Move a token past the edge of the page and, as a player, you stop seeing it. The
GM still does. This is in Roll20's shader: fragments outside the page are
discarded unless the GM flag is set.

This module sets that flag. The token comes back, drawn at half opacity — that
is Roll20's own treatment of anything off the page, and it tells you at a glance
that the token is outside.

The flag is read in exactly one place in the shader, the edge test. It reveals
nothing else, and nothing the server has not already sent to your client. For a
GM the module does nothing at all.

Jumpgate only. The legacy renderer has no shader and never hid these tokens.
</div>

<div class="vttk-module" markdown>
### Chat footer

Fixes the vertical alignment of the bottom row, where the sender select and the
Send button sat at different heights. Adds an emoji picker.

The emoji are standard Unicode, in the eight official groups. Everyone can read
them.
</div>

</div>

## Roll20's two renderers

Roll20 runs two rendering engines behind the same interface: the current one
(Jumpgate) and the legacy one, still used by older campaigns.

Four of the five tools work on both, as GM and as player. Each combination was
tested on a live game. Tokens off the map is the exception: the legacy renderer
never hid them, so there is nothing for it to do there and it says so.

## Cost

| | |
| --- | --- |
| Per frame, all tools on | 0.2 ms |
| CPU | 3.5% of one core |
| Frame rate | 181 → 176 fps |

Measured on a live game. The drawing layer only runs when a tool has something
to draw; otherwise it is not in the page at all.
