---
hide:
  - navigation
---

<div class="vttk-banniere" markdown>
<span class="vttk-version">version 0.51.0</span>

# VTTinker

A browser extension for Roll20. It raises the zoom limits, draws the grid past
the map edge, lets you add your own token markers, and fixes the chat footer.
Each tool has its own on/off switch.
</div>

<div class="vttk-paquets" markdown>

<div class="vttk-paquet" markdown>
### Firefox <span class="etat signe">signed</span>

Signed by Mozilla. Install it once and Firefox keeps it.

[Download .xpi](vttinker-firefox.xpi){ .vttk-bouton download }
</div>

<div class="vttk-paquet" markdown>
### Chrome <span class="etat">developer mode</span>

Not on the Chrome Web Store, so it loads as an unpacked extension.

[Download .zip](vttinker-chrome.zip){ .vttk-bouton .creux download }
</div>

</div>

## Install on Firefox

<ol class="vttk-etapes" markdown>
<li markdown>Download the `.xpi` file.</li>
<li markdown>Open it. If nothing happens, go to `about:addons`, click the gear
icon, choose **Install Add-on From File**, and pick the downloaded file.</li>
<li markdown>Accept the permission request. There is one: *storage*.</li>
<li markdown>Open a Roll20 game. A **VTTK** section appears at the bottom of the
left toolbar.</li>
</ol>

## Install on Chrome

<ol class="vttk-etapes" markdown>
<li markdown>Download the `.zip` and extract it to a folder you intend to keep.
Chrome reads that folder on every startup.</li>
<li markdown>Go to `chrome://extensions` and turn on **Developer mode**.</li>
<li markdown>Click **Load unpacked** and select the extracted folder, the one
containing `manifest.json`.</li>
<li markdown>Open a Roll20 game. The **VTTK** section appears in the toolbar.</li>
</ol>

!!! warning "Developer mode"
    Chrome shows a warning banner at startup and may disable unpacked extensions
    when you reset your profile. Reload the folder if that happens.

## Access

| | |
| --- | --- |
| Permissions | `storage` |
| Sites | `app.roll20.net/editor` |
| Network | none, except images you add as markers |
| Written to Roll20 | token status markers you place |
| Stored locally | your settings and marker palette |

Source: [github.com/igneefleur/vttinker](https://github.com/igneefleur/vttinker)
