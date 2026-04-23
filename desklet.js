const { SimpleWxDesklet } = require("./loaders");

export const Desklet = imports.ui.desklet;
export const St = imports.gi.St;
export const GLib = imports.gi.GLib;
export const Gio = imports.gi.Gio;
export const Soup = imports.gi.Soup;
export const Pango = imports.gi.Pango;
export const Mainloop = imports.mainloop;
export const Settings = imports.ui.settings;
//resolves weirdness around text and object position in the container
export const Clutter = imports.gi.Clutter;
//
// ── Migraine indicator weights ───────────────────────────
// Adjust these based on your personal experience over time
export const MX = {
    PRESSURE_DROP_MILD: 0.03,   // inHg — mild drop threshold
    PRESSURE_DROP_SHARP: 0.10,   // inHg — sharp drop threshold
    SCORE_PRESSURE_MILD: 2,
    SCORE_PRESSURE_SHARP: 3,      // cumulative with mild
    KP_THRESHOLD_MILD: 4,
    KP_THRESHOLD_SEVERE: 6,
    SCORE_KP_MILD: 2,
    SCORE_KP_SEVERE: 3,      // cumulative with mild
    ELECTRON_ELEVATED: 1000,   // pfu — calibrate from observation
    PROTON_ELEVATED: 10,      // pfu — calibrate from observation
    SCORE_ELECTRON: 2,
    SCORE_PROTON: 2,
    TEMP_SWING: 10,     // °F forecasted change
    SCORE_TEMP_SWING: 1,
    WIND_HIGH: 20,     // mph
    SCORE_WIND: 1,
};

export const USER_AGENT = 'SimpleWx/5.0 simplewx@wd8ta';
export const REFRESH_FLOOR_S = 600;
const SPACE_WX_SECS = 900;
export const PRESSURE_HISTORY_MAX = 6;  // keep last 6 readings for trend

// K-index → geomagnetic state + color
const KP_STATES = [
    { label: 'Quiet', color: '#44cc44' },
    { label: 'Quiet', color: '#44cc44' },
    { label: 'Quiet', color: '#88cc44' },
    { label: 'Unsettled', color: '#cccc00' },
    { label: 'Active', color: '#ffaa00' },
    { label: 'Minor Storm', color: '#ff7700' },
    { label: 'Moderate Storm', color: '#ff4400' },
    { label: 'Strong Storm', color: '#ff2200' },
    { label: 'Severe Storm', color: '#ff0000' },
    { label: 'Extreme Storm', color: '#cc0000' },
];

export function kpState(kp) {
    return KP_STATES[Math.min(Math.round(parseFloat(kp)), 9)] || KP_STATES[0];
}

// Wind direction string → Unicode arrow (direction wind is blowing toward)
export function windArrow(dir) {
    const map = {
        'N': '↓', 'NNE': '↓', 'NE': '↙', 'ENE': '←',
        'E': '←', 'ESE': '←', 'SE': '↖', 'SSE': '↑',
        'S': '↑', 'SSW': '↑', 'SW': '↗', 'WSW': '→',
        'W': '→', 'WNW': '→', 'NW': '↘', 'NNW': '↓',
        'CALM': '○', 'VAR': '~'
    };
    return map[(dir || '').trim().toUpperCase()] || '?';
}

function main(metadata, desklet_id) {
    return new SimpleWxDesklet(metadata, desklet_id);
}