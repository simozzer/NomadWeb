# Nomad Web

A browser-based editor for the Clavia Nord Modular, driving the hardware over Web MIDI.

This is a port of [Nomad](http://nmedit.sourceforge.net/) 0.3.2 (Christian Schneider,
NMedit project). Nomad separated the *description* of the Nord Modular from its Java
renderer, and that separation is what makes a browser port tractable: the protocol, the
module catalogue, the panel layouts and the value formatters are all data files, carried
over here unchanged.

## Running it

```
npm install
npm run dev      # http://localhost:5173
npm test         # protocol, model and layout checks
```

Web MIDI with SysEx needs a **secure context** — `localhost` during development, HTTPS
when deployed — and a permission grant. The Nord Modular is driven entirely by SysEx, so
access granted without it is refused rather than silently half-working.

Browser support: solid on Chromium (Chrome, Edge, Opera). Safari and Firefox shipped Web
MIDI more recently and are less battle-tested for SysEx-heavy use.

## What is carried over unchanged

| File | Role |
|---|---|
| `public/data/midi.pdl2` | Bit-level grammar for the whole Clavia SysEx protocol |
| `public/data/patch.pdl2` | Grammar for the `.pch` patch format |
| `public/data/modules.xml` | 110 modules: connectors, signal types, parameter ranges, DSP cost |
| `public/data/classic-theme.xml` | Pixel layout of every module panel |
| `public/data/nmformat.js` | Value formatters — original ES3, runs as-is |
| `public/data/theme-images/` | Button face graphics |

Nothing about any individual module is hardcoded in the TypeScript. Adding a module means
editing the XML, exactly as it did upstream.

## Architecture

```
src/pdl2/      JPDL2 engine — lexer, parser, bit-level decode/encode
src/midi/      SysEx framing, Web MIDI transport, Nord message layer
src/model/     modules.xml, classic-theme.xml and nmformat.js loaders
src/ui/        SVG module renderer
```

The PDL2 engine is the keystone. Rather than hand-writing codecs for ~70 message types, it
interprets the grammar files directly, so the protocol spec stays the single source of
truth — including the checksum rule, which the grammar expresses declaratively.

## State

**Working and verified**

- PDL2 engine — 71 protocol rules, 132 patch rules, parsed from the spec files
- Backtracking decoder (continuation-passing), needed for the recursive
  optional chains in the patch list and patch dumps
- Device handshake, patch list, patch load and patch dump over Web MIDI
- Patch canvas: modules on the 255x15 grid, cables, drag, patch and cut
- Live edits sent as real messages: parameter, module move, cable add/delete
- Module catalogue and panel layouts: 1066 bindings, 382 connectors, none dangling
- All 45 value formatters compile and evaluate

103 checks pass (Unknown command: "test"


Did you mean this?
  npm test # Test a package
To see a list of supported npm commands, run:
  npm help).

**Not yet done**

- Adding modules to a patch ( goes via a patch packet, cc 0x1f)
- Storing a patch back to a bank, and .pch file import/export
- Undo
- Morph assignments, knob and MIDI-controller mappings
- Custom panel graphics — LFO shapes, envelope curves — drawn as placeholders
- Meters and LEDs are decoded but not shown on the panels

**Hardware status.** Device identification, the patch list and patch loading have
been exercised against a real Nord Modular. The canvas edit messages
(move, cable add/delete) are verified against their bit layouts in tests but have
not been confirmed on hardware.

## Licence

Nomad is GPL v2. This port is a derivative work and carries the same licence.
The original `LICENSE_nomad.txt` applies to the data files and to this port.
