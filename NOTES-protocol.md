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
