# Protocol findings

Verified against the SysEx captures recorded in the comments of `midi.pdl2`.

## Confirmed

**Bit packing is MSB-first.** In `F0 33 50 06 ...`, byte `0x50` under `0:1 cc:5 slot:2`
yields `cc=0x14` (NMInfo), `slot=0`, matching the Clavia command table.

**The checksum rule is correct as written.** `[+;0;@lblDataEnd;8;$] % 128` — sum every
whole byte from the start of the message up to the checksum byte, mod 128. Hand-checked
on the ACK capture: bytes `F0 33 58 06 08 0D 08 21 00 01` sum to 448; `448 % 128 = 64 = 0x40`,
which is the recorded checksum. All decoded vectors validate with `validateComputed: true`.

## `Meters` now parses

The header comment of `midi.pdl2` lists

    F0 33 50 06 07 3A 00 07 00 00 00 00 00 00 00 00 00 41 F7

under "parse failed". It decodes cleanly here — 19/19 bytes, checksum valid. The upstream
failure was in the Java `PDLPacketParser`, not in the grammar.

## Two genuine issues

### 1. Interleaved messages on the wire (needs transport-level resync)

The second "parse failed" capture is not a single message:

    F0 33 50 06 20 3A 00 07 00 F0 33 50 06 20 39 00 11 00 00 00 00 00 00 63 F7
                               ^^ a second SysEx starts here, before the first ends

A `Lights` message (`39`) is spliced into the middle of a `Meters` message (`3A`), and the
first message's terminating `F7` never arrives. The device emits this under load — both
captures are meters/lights traffic, which the synth sends continuously.

**Handling:** frame on `F0`, and treat an `F0` seen before the expected `F7` as the start of
a new message, discarding the truncated one. Implemented in `src/midi/framing.ts`.
Dropping a meter/light frame is harmless; they are re-sent continuously.

### 2. `UnknownNMInfo` has an off-by-one, direction unresolved

The grammar declares seven leading fields:

    UnknownNMInfo := 0:1 unknown1:7 ... 0:1 unknown7:7 String$name 0:1 unknown8:7

but the recorded capture has only six bytes before the text begins:

    F0 33 50 06 04 13 | 51 06 16 00 03 02 | 56 45 6C 70 69 61 6E 6F 20 36 00 | 05 | 7B F7
                        six bytes           V  E  l  p  i  a  n  o  _  6  NUL

The comment on that capture says the name is `VElpiano 6`; the grammar as written yields
`Elpiano 6`, with `unknown7` consuming the `V`.

The checksum cannot settle this — both readings consume the same 26 bytes, so both validate.
Resolving it needs a device: set a patch name with a known first character and read it back.

Low stakes either way. `UnknownNMInfo` is a message the original author could not identify
(every field is named `unknownN`), and the patch name is also carried by `SetPatchTitle`
(`0x27`), which is unambiguous. Left as-is, matching the grammar.

## Patch list

Command codes taken from `GetPatchListMessage.<init>` in `jnmprotocol2.jar`, whose
bytecode pushes `0x17`, `0x41`, `0x14` in order:

| Field | Value | Meaning |
|---|---|---|
| `cc` | `0x17` | PatchHandling |
| `pp` | `0x41` | PatchManagerCommand |
| `ssc` | `0x14` | GetPatchList |

A request is ten bytes: `F0 33 5C 06 41 14 <bank> <position> <checksum> F7`, where `0x5C`
is `cc=0x17, slot=0` packed as `0:1 cc:5 slot:2`. Bounds come from the same class: nine
banks, positions 0-99.

The reply is an ACK (`cc=0x16`) of type `0x13`/`0x15` carrying a `PatchListResponse`.

### Backtracking is required to parse it

`PatchListResponse` ends `?StringList$data 0:1 endmarker:7`, and `StringList` recurses
through `?StringList$next`. Because `String` is `16*chars:8/0`, an empty name matches zero
bytes and is indistinguishable from the trailing endmarker — so a greedy optional swallows
the endmarker *and* the checksum, and the packet never closes.

The decoder therefore runs in continuation-passing style: an optional or alternative
commits only once the rest of the packet has parsed, and is retried otherwise. Two guards
keep that safe — an optional that consumes zero bits is skipped rather than recursed into,
and a step ceiling turns a pathological packet into an error instead of a hang.

This matters beyond the patch list: patch dumps use the same recursive-optional shape.

### Cursor semantics (inferred — worth confirming against hardware)

Entries are consecutive unless a `ListCmd` moves the cursor:

| Code | Effect |
|---|---|
| `0x01` | set position explicitly |
| `0x02` | slot is empty; cursor still advances |
| `0x03` | jump to bank and position |
| `0x05` | as `0x03`, after an overwrite |
| absent | advance one position |

The traversal path matches what `PatchListMessage` walks: `data:patchList:data`, then
`cmd`/`code`, `nextposition:position`, `nextsection:section`, `name`, `next`.

Only the `0x02` behaviour is a guess. The grammar gives `EmptyPosition` zero width, so
nothing says whether the cursor advances; treating it as advancing is what keeps positions
unique. If a real bank comes back with duplicated or shifted positions around empty slots,
this is the line to change.
