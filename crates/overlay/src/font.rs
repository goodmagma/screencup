//! A tiny 5×7 bitmap font for the magnifier's readout: digits, hex letters and the few
//! symbols coordinates, sizes and colours need. No font files or text-rendering crates.

/// Glyph size in font pixels.
const GLYPH_W: i32 = 5;
const GLYPH_H: i32 = 7;
/// Font pixels per screen pixel.
pub const SCALE: i32 = 2;
/// Horizontal advance per character, in screen pixels.
pub const ADVANCE: i32 = (GLYPH_W + 1) * SCALE;
/// Line height in screen pixels.
pub const HEIGHT: i32 = GLYPH_H * SCALE;

/// Rows top to bottom; bit 4 is the leftmost column.
fn glyph(c: char) -> [u8; 7] {
    match c {
        '0' => [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
        '1' => [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
        '2' => [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
        '3' => [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
        '4' => [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
        '5' => [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
        '6' => [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
        '7' => [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
        '8' => [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
        '9' => [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
        'A' => [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
        'B' => [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
        'C' => [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
        'D' => [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
        'E' => [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
        'F' => [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
        '#' => [0b01010, 0b01010, 0b11111, 0b01010, 0b11111, 0b01010, 0b01010],
        ',' => [0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b00100, 0b01000],
        '-' => [0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000],
        // Multiplication sign, for sizes such as 640×480.
        '×' => [0b00000, 0b00000, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001],
        _ => [0; 7],
    }
}

/// Width of `text` in screen pixels, without the trailing gap.
pub fn width(text: &str) -> i32 {
    let n = text.chars().count() as i32;
    if n == 0 { 0 } else { n * ADVANCE - SCALE }
}

/// Calls `fill(x0, y0, x1, y1)` for every lit block of `text` drawn at (`x`, `y`).
pub fn draw(text: &str, x: i32, y: i32, mut fill: impl FnMut(i32, i32, i32, i32)) {
    for (i, c) in text.chars().enumerate() {
        let gx = x + i as i32 * ADVANCE;
        for (row, bits) in glyph(c).iter().enumerate() {
            for col in 0..GLYPH_W {
                if bits & (1 << (GLYPH_W - 1 - col)) != 0 {
                    let (px, py) = (gx + col * SCALE, y + row as i32 * SCALE);
                    fill(px, py, px + SCALE, py + SCALE);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn width_counts_gaps_between_characters_only() {
        assert_eq!(width(""), 0);
        assert_eq!(width("1"), GLYPH_W * SCALE);
        assert_eq!(width("#2D8CFF"), 7 * ADVANCE - SCALE);
    }

    #[test]
    fn every_readout_character_has_a_glyph() {
        for c in "0123456789ABCDEF#,-×".chars() {
            assert!(glyph(c).iter().any(|row| *row != 0), "{c} is blank");
        }
    }
}
