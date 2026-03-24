/**
 * Gacha shared enums — single source of truth.
 *
 * Values are kept in sync with user-backend/prisma/schema.prisma.
 * Both frontend and backend import from here instead of defining their own.
 */
export const RARITY_VALUES = ['WHITE', 'GREEN', 'BLUE', 'PURPLE', 'GOLD'];
export const AFFIX_VISUAL_STYLE_VALUES = [
    'NONE', 'MONO', 'SILVER', 'GOLD', 'CYAN', 'PRISM', 'COLORLESS',
    'WILDCARD', 'SPECTRUM', 'MIRROR', 'ORBIT', 'ECHO',
    'NEXUS', 'ANCHOR', 'FLUX',
];
