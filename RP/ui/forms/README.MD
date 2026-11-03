# Custom Form Use

As of now, to specify a custom form on a certain ActionFormData class, I am using the title text.
Each form is flagged by a **signature** prepended to the title. Every character of a
signature is `§`-escaped (e.g. `§❖§C§D`) so the whole token renders invisible in-game, and
the shared `§❖` prefix namespaces them to Obsidian Essentials so they will **not** collide
with other add-ons' form titles. The detection lives in `server_form.json` / the form JSON
via string subtraction `(#title_text - $signature)`.

Signatures are defined in `RP/ui/_global_variables.json` and MUST be emitted verbatim by the
scripts that open each form. Current list:

- `$community` = `§❖§C§D` — Community styled form (community forms ONLY)
- `$communityMOBILE` = `§❖§C§M` — Community form, mobile/console layout
- `$communityOG` = `§❖§C§O` — Community form, OG layout
- `$communitym` = `§❖§C§X` — Community styled modal form (ModalFormData only)
- `$admin` = `§❖§A§D` — Admin styled form (Admin forms ONLY; body + icon'd buttons)
- `$adminMOBILE` = `§❖§A§M` — Admin form, mobile/console layout
- `$adminOG` = `§❖§A§O` — Admin form, OG layout
- `$adminm` = `§❖§A§X` — Admin styled modal form (ModalFormData only)
- `§❖§L§G` — Changelogs panel (`§❖§L§G§❖§L§D` = changelog detail screen)
- `§❖§D§R` — Daily Rewards
- `§❖§C§R` — Credits

> Sidebar position codes ($sb / $smallsb / $sbLEFT ...) use a separate, legacy single-char
> scheme and are intentionally NOT part of this signature system.

Perhaps you put Community and Admin in the same title.. What happens?? Overlapping does. Do NOT make this mistake.
Depite these all being made generally for ActionFormData, trying to use them on ModalFormData will have no such effect.
The same goes if you try to use ModalFormData on ActionFormData.
