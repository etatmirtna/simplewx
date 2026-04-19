const Desklet = imports.ui.desklet;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Soup = imports.gi.Soup;
const Mainloop = imports.mainloop;
const Settings = imports.ui.settings;

const GEOLOCATION_URL = 'http://ip-api.com/json/';
const USER_AGENT = 'SimpleWx/2.0 simplewx@wd8ta';
const REFRESH_MIN_SECONDS = 600; // hard floor: 10 minutes

class SimpleWxDesklet extends Desklet.Desklet {

    constructor(metadata, desklet_id) {
        super(metadata, desklet_id);
        this._assetsPath = `${metadata.path}/assets`;
        this._forecastUrl = null;
        this._refreshTimer = null;
        this._currentLocation = null; // { name, lat, lon }
        this._favorites = [];
        this._activeFavIndex = 0;
        this._usingGeolocation = false;

        this._bindSettings(metadata, desklet_id);
        this._buildUI();
        this._loadLocations();
        this._startWeather();
    }

    // -------------------------------------------------------
    // Settings binding
    // -------------------------------------------------------
    _bindSettings(metadata, desklet_id) {
        this.settings = new Settings.DeskletSettings(this, metadata.uuid, desklet_id);
        this.settings.bind('use-geolocation',  'useGeolocation',   this._onSettingsChanged.bind(this));
        this.settings.bind('units',            'units',            this._onSettingsChanged.bind(this));
        this.settings.bind('refresh-interval', 'refreshInterval',  this._onSettingsChanged.bind(this));
        this.settings.bind('default-favorite', 'defaultFavorite',  null);

        for (let i = 1; i <= 5; i++) {
            this.settings.bind(`fav${i}-name`, `fav${i}Name`, null);
            this.settings.bind(`fav${i}-lat`,  `fav${i}Lat`,  null);
            this.settings.bind(`fav${i}-lon`,  `fav${i}Lon`,  null);
        }
    }

    _onSettingsChanged() {
        this._loadLocations();
        this._startWeather();
    }

    // -------------------------------------------------------
    // Build favorites list from settings
    // -------------------------------------------------------
    _loadLocations() {
        this._favorites = [];
        for (let i = 1; i <= 5; i++) {
            let name = this[`fav${i}Name`];
            let lat  = parseFloat(this[`fav${i}Lat`]);
            let lon  = parseFloat(this[`fav${i}Lon`]);
            if (name && name.trim() !== '' && !isNaN(lat) && !isNaN(lon)) {
                this._favorites.push({ name: name.trim(), lat, lon });
            }
        }
        // defaultFavorite is 1-based in settings, 0-based internally
        this._activeFavIndex = Math.min(
            Math.max(0, (this.defaultFavorite || 1) - 1),
            Math.max(0, this._favorites.length - 1)
        );
    }

    // -------------------------------------------------------
    // UI Construction
    // -------------------------------------------------------
    _buildUI() {
        this._container = new St.BoxLayout({
            vertical: true,
            style_class: 'simplewx-container'
        });

        // --- Navigation row: ◀  City Name  ▶ ---
        let navRow = new St.BoxLayout({
            vertical: false,
            style_class: 'simplewx-nav-row'
        });

        this._prevBtn = new St.Button({
            label: '◀',
            style_class: 'simplewx-nav-btn'
        });
        this._prevBtn.connect('clicked', () => this._cycleLocation(-1));

        this._locationLabel = new St.Label({
            text: 'Locating...',
            style_class: 'simplewx-location'
        });

        this._nextBtn = new St.Button({
            label: '▶',
            style_class: 'simplewx-nav-btn'
        });
        this._nextBtn.connect('clicked', () => this._cycleLocation(1));

        navRow.add_child(this._prevBtn);
        navRow.add_child(this._locationLabel);
        navRow.add_child(this._nextBtn);

        // --- Weather icon ---
        this._weatherIcon = new St.Icon({
            icon_size: 72,
            style_class: 'simplewx-icon'
        });

        // --- Temperature ---
        this._tempLabel = new St.Label({
            text: '--°F',
            style_class: 'simplewx-temp'
        });

        // --- Condition text ---
        this._condLabel = new St.Label({
            text: 'Fetching weather...',
            style_class: 'simplewx-condition'
        });

        // --- Wind ---
        this._windLabel = new St.Label({
            text: '',
            style_class: 'simplewx-wind'
        });

        this._container.add_child(navRow);
        this._container.add_child(this._weatherIcon);
        this._container.add_child(this._tempLabel);
        this._container.add_child(this._condLabel);
        this._container.add_child(this._windLabel);

        this.setContent(this._container);
    }

    // -------------------------------------------------------
    // Manual cycle through favorites via nav buttons
    // -------------------------------------------------------
    _cycleLocation(direction) {
        if (this._favorites.length === 0) return;
        this._usingGeolocation = false;
        this._activeFavIndex = (this._activeFavIndex + direction + this._favorites.length)
                               % this._favorites.length;
        this._currentLocation = this._favorites[this._activeFavIndex];
        this._forecastUrl = null; // force re-resolve for new location
        this._locationLabel.set_text(this._currentLocation.name);
        this._fetchPoints();
    }

    // -------------------------------------------------------
    // Weather startup — geolocation or fallback
    // -------------------------------------------------------
    _startWeather() {
        this._forecastUrl = null;
        this._locationLabel.set_text('Locating...');

        if (this.useGeolocation) {
            this._geolocate();
        } else {
            this._useDefaultFavorite();
        }
    }

    // -------------------------------------------------------
    // IP-based geolocation via ip-api.com
    // -------------------------------------------------------
    _geolocate() {
        let session = new Soup.Session();
        let message = Soup.Message.new('GET', GEOLOCATION_URL);
        message.request_headers.append('User-Agent', USER_AGENT);

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                let bytes = session.send_and_read_finish(result);
                let json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                if (json.status === 'success') {
                    this._currentLocation = {
                        name: `${json.city}, ${json.regionName}`,
                        lat: json.lat,
                        lon: json.lon
                    };
                    this._usingGeolocation = true;
                    this._locationLabel.set_text(`📍 ${this._currentLocation.name}`);
                    this._fetchPoints();
                } else {
                    throw new Error(`ip-api status: ${json.message || 'unknown'}`);
                }
            } catch (e) {
                log(`SimpleWx: Geolocation failed (${e}) — falling back to default favorite`);
                this._useDefaultFavorite();
            }
        });
    }

    // -------------------------------------------------------
    // Fallback: use configured default favorite
    // -------------------------------------------------------
    _useDefaultFavorite() {
        this._usingGeolocation = false;
        if (this._favorites.length === 0) {
            this._setError('No favorites configured and geolocation unavailable');
            return;
        }
        this._currentLocation = this._favorites[this._activeFavIndex];
        this._locationLabel.set_text(this._currentLocation.name);
        this._fetchPoints();
    }

    // -------------------------------------------------------
    // NWS Step 1: resolve lat/lon → forecast endpoint URL
    // -------------------------------------------------------
    _fetchPoints() {
        if (!this._currentLocation) return;
        let { lat, lon } = this._currentLocation;
        let url = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`;

        let session = new Soup.Session();
        let message = Soup.Message.new('GET', url);
        message.request_headers.append('User-Agent', USER_AGENT);

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                let bytes = session.send_and_read_finish(result);
                let json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                this._forecastUrl = json.properties.forecastHourly;
                this._fetchForecast();
            } catch (e) {
                this._setError(`NWS points lookup failed: ${e}`);
            }
        });
    }

    // -------------------------------------------------------
    // NWS Step 2: fetch hourly forecast, use period[0]
    // -------------------------------------------------------
    _fetchForecast() {
        if (!this._forecastUrl) { this._fetchPoints(); return; }

        let session = new Soup.Session();
        let message = Soup.Message.new('GET', this._forecastUrl);
        message.request_headers.append('User-Agent', USER_AGENT);

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                let bytes = session.send_and_read_finish(result);
                let json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                let current = json.properties.periods[0];
                this._updateDisplay(current);
                this._scheduleRefresh();
            } catch (e) {
                this._setError(`Forecast fetch failed: ${e}`);
                this._scheduleRefresh(); // retry later even on failure
            }
        });
    }

    // -------------------------------------------------------
    // Update UI with current period data
    // -------------------------------------------------------
    _updateDisplay(period) {
        let { temperature, temperatureUnit, shortForecast, isDaytime, windSpeed, windDirection } = period;

        let temp = temperature;
        let unit = temperatureUnit;
        if (this.units === 'C' && temperatureUnit === 'F') {
            temp = Math.round((temperature - 32) * 5 / 9);
            unit = 'C';
        }

        this._tempLabel.set_text(`${temp}°${unit}`);
        this._condLabel.set_text(shortForecast);
        this._windLabel.set_text(`Wind: ${windDirection} ${windSpeed}`);

        let iconPath = this._resolveIcon(shortForecast, isDaytime);
        this._weatherIcon.set_gicon(Gio.icon_new_for_string(iconPath));
    }

    // -------------------------------------------------------
    // Map NWS shortForecast → icon filename
    // -------------------------------------------------------
    _resolveIcon(shortForecast, isDaytime) {
        const fc = shortForecast.toLowerCase();
        const tod = isDaytime ? 'day' : 'night';

        if (fc.includes('thunder'))
            return this._icon(`wx-${tod}-thunderstorm-72`, `wx-thunderstorm-72`);
        if (fc.includes('blizzard') || fc.includes('snow') || fc.includes('flurr'))
            return this._icon(`wx-${tod}-snow-72`, `wx-snow-72`);
        if (fc.includes('sleet') || fc.includes('ice pellet'))
            return this._icon(`wx-${tod}-sleet-72`, `wx-sleet-72`);
        if (fc.includes('freez'))
            return this._icon(`wx-freezing-rain-72`);
        if (fc.includes('shower') || fc.includes('drizzle') || fc.includes('rain')) {
            if (fc.includes('slight') || fc.includes('chance') || fc.includes('scattered') || fc.includes('iso'))
                return this._icon(`wx-scattered-showers-72`);
            return this._icon(`wx-showers-72`);
        }
        if (fc.includes('fog') || fc.includes('mist'))
            return this._icon(`wx-${tod}-fog-72`, `wx-fog-72`);
        if (fc.includes('haze') || fc.includes('smoke') || fc.includes('dust'))
            return this._icon(`wx-${tod}-haze-72`, `wx-haze-72`);
        if (fc.includes('windy') || fc.includes('breezy'))
            return this._icon(`wx-windy-72`);
        if (fc.includes('overcast'))
            return this._icon(`wx-${tod}-overcast-72`, `wx-overcast-72`);
        if (fc.includes('mostly cloudy') || fc.includes('considerable cloud'))
            return this._icon(`wx-${tod}-partly-cloudy-72`);
        if (fc.includes('partly cloudy') || fc.includes('partly sunny'))
            return this._icon(`wx-${tod}-partly-cloudy-72`);
        if (fc.includes('mostly clear') || fc.includes('mostly sunny') ||
            fc.includes('few clouds') || fc.includes('scattered clouds'))
            return this._icon(`wx-${tod}-scattered-clouds-72`);

        return this._icon(`wx-${tod}-clear-72`);
    }

    // Fallback chain: try each name until a file exists
    _icon(...names) {
        for (let name of names) {
            let path = `${this._assetsPath}/${name}.png`;
            if (GLib.file_test(path, GLib.FileTest.EXISTS)) return path;
        }
        return `${this._assetsPath}/${names[0]}.png`;
    }

    // -------------------------------------------------------
    // Refresh scheduling
    // -------------------------------------------------------
    _scheduleRefresh() {
        if (this._refreshTimer) Mainloop.source_remove(this._refreshTimer);
        let seconds = Math.max(REFRESH_MIN_SECONDS, (this.refreshInterval || 30) * 60);
        this._refreshTimer = Mainloop.timeout_add_seconds(seconds, () => {
            // On auto-refresh, re-geolocate if that's our current mode
            if (this.useGeolocation && this._usingGeolocation) {
                this._geolocate();
            } else {
                this._fetchForecast();
            }
            return false; // don't auto-repeat; re-scheduled after each fetch
        });
    }

    _setError(msg) {
        log(`SimpleWx ERROR: ${msg}`);
        this._condLabel.set_text('Weather unavailable');
        this._locationLabel.set_text('Error — check logs');
    }

    on_desklet_removed() {
        if (this._refreshTimer) {
            Mainloop.source_remove(this._refreshTimer);
            this._refreshTimer = null;
        }
    }
}

function main(metadata, desklet_id) {
    return new SimpleWxDesklet(metadata, desklet_id);
}
