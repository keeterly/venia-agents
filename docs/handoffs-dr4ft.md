# Dr4ft → tech pack: the handoff contract

How Dr4ft (the pattern CAD, built in `keeterly/venia-pattern-cad`) sends a
pattern to a style's tech pack in VENIA OS. The receiving side shipped in
Build 658. This page is everything the CAD needs to add its **Send** button.
No CAD code goes in this repository.

## 1. Two ways to send

| Where Dr4ft runs | How it sends | Who checks it |
|---|---|---|
| **Inside VENIA OS** (the Dr4ft space, in a frame at `/pattern-cad`) | `window.veniaHandoff.send(...)`, provided by the frame loader `modules/pattern-cad/src/host.js` | the shell: both modules on, the style exists, then it records and delivers |
| **On its own** (opened outside VENIA OS) | not offered in this first version; `send()` answers `{ ok:false }` (see §2) | — |

Inside VENIA OS is the only supported route for now. A later version may let
the stand-alone CAD write the queue row itself (§6 says what that would take).

## 2. Knowing it's inside VENIA OS

`modules/pattern-cad/src/host.js` runs before the CAD and always defines
`window.veniaHandoff`. Also reachable as `window.claude.use('venia-handoff')`.

```js
const h = window.veniaHandoff;                 // always defined by the loader
const where = h ? await h.targets('pattern') : [];
const canSend = where.some(t => t.module === 'product' && t.into === 'techpack');
```

- Inside VENIA OS, with Product on for this brand and person: `targets('pattern')`
  resolves `[{ module: 'product', into: 'techpack', label: 'Tech pack' }]`.
- Inside VENIA OS without Product, or Dr4ft switched off: `[]`.
- On its own: `[]`, and `send()` resolves
  `{ ok: false, message: 'Open Dr4ft inside VENIA OS to send a pattern to a tech pack.' }`.

Show the Send button only when `canSend` is true. `targets()` gives up after 8
seconds and resolves `[]`.

## 3. Sending

```js
const r = await window.veniaHandoff.send({
  into: { styleId: 'STYabc123', part: 'techpack' },   // the VENIA OS style
  pattern: { /* §4 */ },
});
// r = { ok: true, id, queued, styleName, styleCode }
//   | { ok: false, message }        // show message as is; it is written for a person
```

- `into.styleId` is the style's VENIA OS id (the `id` that `list_styles` /
  `get_style` already return to the CAD's "Link to a VENIA OS style"), or its
  style code (`VN-001`). Use the style the pattern is linked to.
- `into.part` is `'techpack'` (the only place that accepts patterns today).
- `queued: true` means it was also written to the queue (§5); `false` means the
  queue could not be reached (offline). It still landed on this device.
- `send()` gives up after 20 seconds and resolves
  `{ ok: false, timeout: true, message }`.

Messages the CAD may get back, already worded for the person:
`Pick a VENIA OS style to send it to.` · `Save the pattern first, so it has a
name to link to.` (no `pattern.id`) · `That style isn't in the line list.` ·
`Dr4ft isn't switched on for you here.` · `That is too big to hand over in one go.`

## 4. The pattern payload

```js
pattern = {
  id: 'PAT-0042',            // REQUIRED. Stable for the life of the pattern; the same
                             //   id with a new version is "an update", not a new pattern.
  name: 'Hamlet coat',       // what the person calls it (≤120 chars)
  version: 3,                // number or short text (≤40). Bump it on every send that changed.
  baseSize: 'M',             // ≤30
  sizes: ['XS','S','M','L'], // array, or 'XS,S,M,L'
  gradeRule: 'Standard RTW grade',  // free text ≤80
  pieces: [                  // ≤300
    { name: 'Front',          // ≤80
      component: 'Shell',     // Shell | Lining | Interlining | Facing | Underlining | Interfacing
                              //   (any case; anything else becomes Shell)
      cut: 2,                 // how many to cut, ≤12 chars
      material: 'Wool twill', // the fabric's NAME; matched to a VENIA OS material by name
      grain: 'Straight grain',
      fused: false,           // true adds "Fused" to the piece's notes
      notes: '' },            // ≤300
  ],
  picture: 'https://…',      // optional: an https address of a picture of the pieces.
                             //   data: URLs are dropped (too big for the record).
  files: ['Hamlet-coat-v3.dxf'],  // optional: file NAMES only, ≤10 (see below)
}
```

- Plain data only: no functions, dates as text. The whole payload must be under
  about 400 KB.
- **Files (DXF, plot files) are not carried.** `files` lists names so the tech
  pack can say what exists; the files themselves stay in Dr4ft until VENIA OS
  has shared file storage for modules (a later phase). If a DXF should reach the
  factory now, it goes through Dr4ft's own export as today.
- Text is cleaned on arrival: control characters and `<` `>` removed, trimmed to
  the lengths above.

## 5. The queue: `venia_handoffs`

Every send is also one row in `public.venia_handoffs`, which is how a send
reaches other devices and stays on record. It's created by
`supabase/migrations/20261119_venia_handoffs.sql`. The shell writes it for the
CAD; the CAD never touches it directly in this version.

| Column | For a Dr4ft send |
|---|---|
| `id` uuid | made by the database |
| `tenant_id` text | `'main'` (VENIA) |
| `from_module` / `to_module` | `'pattern-cad'` / `'product'` |
| `kind` | `'pattern'` |
| `address` | `venia://pattern/<pattern.id>` (the id URL-encoded) |
| `into_ref` | `venia://style/<style id>#techpack` |
| `version`, `title` | `pattern.version`, `pattern.name` |
| `snapshot` jsonb | the pattern payload (§4) |
| `status` | `sent` → `accepted` or `declined` |
| `sent_by`, `sent_at` | the signed-in person's email, the time |
| `decided_by`, `decided_at` | who brought it in or turned it down, when |

Rules (row-level security plus a trigger):
- **Read:** anyone who can read either end, in the same brand.
- **Send:** only as yourself (`sent_by` = your sign-in email), only from a
  module you can read (`pattern-cad`: a founder, a `pattern-cad` grant, or a
  brand owner), only to a module the brand has, and only as `status = 'sent'`.
- **Decide:** whoever can change Product, as themselves, to `accepted` or
  `declined`, once. After sending, nothing else in the row can change.
- Rows are never removed. The queue is the record.

## 6. What happens in VENIA OS

1. The style's tech pack, section ⑥ Pattern Card, shows **"Version 3 of Hamlet
   coat came in from Dr4ft"**, with the piece count, base size, grade rule and
   sizes. The section header shows "● New version from Dr4ft". **Nothing on the
   card changes yet.** A newer send replaces an older one that is still waiting,
   and the older one is marked declined.
2. **Bring in** (asks first if the card already has pieces):
   - The piece list is replaced by the pattern's pieces. A piece keeps its
     material (and lot) when an old piece has the same name and part.
     Otherwise the material is matched by name against Materials, or left as
     the name.
   - Base size and grade rule fill in from the pattern. Pattern version becomes
     "Dr4ft v3". Pattern file is set to "Dr4ft: Hamlet coat" if it was empty.
   - The BOM's fabric lines re-sync from the new pieces, as when pieces are
     edited by hand.
   - The card remembers where it came from ("From Dr4ft: Hamlet coat,
     version 3") and keeps what was there before.
   - The queue row is marked `accepted`.
3. **Put back** restores base size, grade rule, version, pattern file and the
   piece list exactly as they were before Bring in.
4. **Not now** clears the waiting version and marks the row `declined`.
5. Sends made on another device, or while VENIA OS was closed, are picked up
   from the queue when VENIA OS opens and whenever it comes back to the front.

**Not in this version:** opening Dr4ft at a given pattern from the tech pack
("Open Dr4ft" opens Dr4ft at its home), carrying the DXF itself, and sending
from Dr4ft on its own. For the last, the CAD would need the person's VENIA OS
sign-in and would insert the §5 row itself; the queue's rules already allow it,
and VENIA OS would pick it up on next open. Ask before building that.

## 7. A suggested button in Dr4ft

Next to the existing "Link to a VENIA OS style": **Send to tech pack**, shown
only when `canSend` (§2) and the pattern is linked to a style. On tap: save,
bump the version if anything changed since the last send, call `send()`, and
show `"Sent to the Hamlet Coat tech pack. It waits there until someone brings it in."`,
or show `r.message` on failure.

## 8. Testing

Inside VENIA OS, open Dr4ft, link a pattern to a test style, and send it. Then
open Product › Tech Pack for that style, open ⑥ Pattern Card, and try Bring
in, Put back and Not now.
