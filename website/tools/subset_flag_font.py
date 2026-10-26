"""Subset TwemojiCountryFlags.woff2 to the given country flags.

Invoked by subset-flag-font.mjs — do not run directly unless debugging:
    python3 subset_flag_font.py <source.woff2> <output.woff2> DE,FR,GB,...

Requires: fonttools, brotli>=1.2.1 (pip install fonttools "brotli>=1.2.1").

harfbuzz-based JS subsetters (subset-font/harfbuzzjs) silently drop the
COLR/CPAL color tables of this font, producing invisible flags — fontTools
subsets them correctly. Each requested flag is validated to have a GSUB
ligature AND COLR color layers so a broken subset can never be emitted.
"""
import io
import sys

from fontTools import subset
from fontTools.ttLib import TTFont


def flag_codepoints(code):
    return [0x1F1E6 + ord(ch) - ord("A") for ch in code]


def ligature_glyph(font, first, second):
    """Return the GSUB ligature glyph for a regional-indicator pair."""
    gsub = font["GSUB"].table
    for lookup in gsub.LookupList.Lookup:
        subtables = []
        if lookup.LookupType == 4:
            subtables = lookup.SubTable
        elif lookup.LookupType == 7:  # extension
            subtables = [st.ExtSubTable for st in lookup.SubTable if st.ExtensionLookupType == 4]
        for st in subtables:
            for lig in st.ligatures.get(first, []):
                if lig.Component == [second]:
                    return lig.LigGlyph
    return None


def main():
    src_path, out_path, codes_arg = sys.argv[1], sys.argv[2], sys.argv[3]
    codes = sorted(codes_arg.split(","))

    font = TTFont(src_path)
    if "COLR" not in font or "CPAL" not in font:
        sys.exit("source font has no COLR/CPAL tables")

    text = "".join(chr(cp) for code in codes for cp in flag_codepoints(code))
    options = subset.Options()
    options.flavor = "woff2"
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=text)
    subsetter.subset(font)

    buf = io.BytesIO()
    font.save(buf)
    result = TTFont(io.BytesIO(buf.getvalue()))

    for table in ("COLR", "CPAL", "GSUB", "cmap"):
        if table not in result:
            sys.exit(f"subset lost the {table} table")

    cmap = result.getBestCmap()
    glyph_name = {}
    for code in codes:
        for cp in flag_codepoints(code):
            if cp not in cmap:
                sys.exit(f"flag {code}: regional indicator U+{cp:X} missing from subset cmap")
        first, second = (cmap[cp] for cp in flag_codepoints(code))
        lig = ligature_glyph(result, first, second)
        if lig is None:
            sys.exit(f"flag {code}: no GSUB ligature in subset — font has no artwork for it")
        glyph_name[code] = lig

    colr = result["COLR"]
    if colr.version == 0:
        for code, lig in glyph_name.items():
            if not colr.ColorLayers.get(lig):
                sys.exit(f"flag {code}: ligature glyph {lig} has no COLR color layers")
    # COLR v1 would need different traversal; Twemoji country flags is v0
    elif colr.version != 0:
        sys.exit(f"unexpected COLR version {colr.version} — validation only supports v0")

    with open(out_path, "wb") as f:
        f.write(buf.getvalue())
    print(f"subset OK: {len(codes)} flags, {len(buf.getvalue())} bytes")


if __name__ == "__main__":
    main()
