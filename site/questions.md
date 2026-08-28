# FAQ

## Do the other players need it too?

No.

A marker you place is written to the game as a regular Roll20 status marker.
Roll20 draws it, not the extension, and the image address travels in the tag.
Everyone sees it.

Same for emoji: they are standard Unicode characters.

The zoom range, the extended grid and the chat layout only affect your own view.

## Why does Chrome need developer mode?

The extension is not published on the Chrome Web Store. Chrome only installs
store items in one click; anything else goes through **Load unpacked**, which
requires developer mode.

Firefox accepts a signed extension without going through its store, which is why
there is an `.xpi` on one side and a `.zip` on the other.

## What leaves my machine?

Nothing. There is no `fetch`, no `XMLHttpRequest`, no `sendBeacon` anywhere in
the code. A test in the build checks this on every change.

The exception is the one you create: if you add a marker pointing at an image,
your browser fetches that image from the host you gave.

!!! note "Worth knowing"
    If another player at your table places a custom marker, your browser fetches
    *their* image from *their* host, and that host sees your IP address. This is
    true of any image shared in a game. The extension sends no referrer.

## Does it slow Roll20 down?

With all four tools on: 0.2 ms per frame, 3.5% of one core, 181 → 176 fps.

The drawing layer only runs when there is something to draw.

## Does it work on older campaigns?

Yes. Roll20 runs two rendering engines; all four tools work on both, as GM and
as player.

## How do I uninstall it?

Through your browser's add-on manager. Your settings go with it.

Markers you placed on tokens stay in the game — they belong to Roll20, not to
the extension. Remove them from the tokens to clear them.

## Can I read the code?

Yes: [github.com/igneefleur/vttinker](https://github.com/igneefleur/vttinker).

It is written in French, comments included. The code is readable; it is not
open source.
