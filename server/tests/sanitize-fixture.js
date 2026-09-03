/**
 * Fixtures containing literal control / zero-width characters, built from
 * escape sequences so the test file itself stays readable and diffable.
 */
export const ZERO_WIDTH_NAME = 'Priya\u200B\uFEFF Sharma';   // ZWSP + BOM inside the name
export const CONTROL_NAME    = 'Priya\u0007 Sharma';         // BEL control character
export const BIDI_INSTITUTE  = 'Bright\u202E Future Academy'; // RTL override
