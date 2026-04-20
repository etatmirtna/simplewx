const Desklet = imports.ui.desklet;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Soup = imports.gi.Soup;
const Pango = imports.gi.Pango;
const Mainloop = imports.mainloop;
const Settings = imports.ui.settings;

const NOAA_XRAY_URL = 'https://services.swpc.noaa.gov/json/goes/primary/xray-flares-latest.json';
const NOAA_WIND_URL = 'https://services.swpc.noaa.gov/products/solar-wind/plasma-7-day.json';
const GEOLOCATION_URL = 'http://ip-api.com/json/';
const NOAA_KINDEX_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
const NOAA_FLUX_URL = 'https://services.swpc.noaa.gov/products/summary/10cm-flux.json';
const USER_AGENT = 'SimpleWx/3.0 simplewx@wd8ta';
const REFRESH_FLOOR_S = 600;   // minimum wx refresh: 10 min
const SPACE_WX_SECS = 900;   // space wx refresh: 15 min

// K-index → geomagnetic state + display color
const KP_STATES = [
    { label: 'Quiet', color: '#44cc44' },  // 0
    { label: 'Quiet', color: '#44cc44' },  // 1
    { label: 'Quiet', color: '#88cc44' },  // 2
    { label: 'Unsettled', color: '#cccc00' },  // 3
    { label: 'Active', color: '#ffaa00' },  // 4
    { label: 'Minor Storm', color: '#ff7700' },  // 5  G1
    { label: 'Moderate Storm', color: '#ff4400' },  // 6  G2
    { label: 'Strong Storm', color: '#ff2200' },  // 7  G3
    { label: 'Severe Storm', color: '#ff0000' },  // 8  G4
    { label: 'Extreme Storm', color: '#cc0000' },  // 9  G5
];

function kpState(kp) {
    return KP_STATES[Math.min(Math.round(parseFloat(kp)), 9)] || KP_STATES[0];
}

// ============================================================
class SimpleWxDesklet extends Desklet.Desklet {

    constructor(metadata, desklet_id) {
        super(metadata, desklet_id);
        this._assetsPath = `${metadata.path}/assets`;
        this._forecastUrl = null;   // NWS hourly
        this._forecastDailyUrl = null;   // NWS daily (7-day)
        this._refreshTimer = null;
        this._spaceWxTimer = null;
        this._currentLocation = null;
        this._favorites = [];
        this._activeFavIndex = 0;
        this._usingGeolocation = false;
        this._popupVisible = false;
        this._detailedForecast = '';
        this._currentKp = 0;
        this._currentSfi = 0;

        this._bindSettings(metadata, desklet_id);
        this._buildUI();
        this._loadLocations();
        this._startWeather();
        this._fetchSpaceWeather();
    }

    // ── Settings ────────────────────────────────────────────
    _bindSettings(metadata, desklet_id) {
        this.settings = new Settings.DeskletSettings(this, metadata.uuid, desklet_id);
        this.settings.bind('use-geolocation', 'useGeolocation', this._onSettingsChanged.bind(this));
        this.settings.bind('units', 'units', this._onSettingsChanged.bind(this));
        this.settings.bind('refresh-interval', 'refreshInterval', this._onSettingsChanged.bind(this));
        this.settings.bind('default-favorite', 'defaultFavorite', null);
        this.settings.bind('show-space-wx', 'showSpaceWx', this._onSpaceWxToggled.bind(this));
        for (let i = 1; i <= 5; i++) {
            this.settings.bind(`fav${i}-name`, `fav${i}Name`, null);
            this.settings.bind(`fav${i}-lat`, `fav${i}Lat`, null);
            this.settings.bind(`fav${i}-lon`, `fav${i}Lon`, null);
        }
    }

    _onSettingsChanged() { this._loadLocations(); this._startWeather(); }
    _onSpaceWxToggled() { this._spaceWxSection.visible = !!this.showSpaceWx; }

    _loadLocations() {
        this._favorites = [];
        for (let i = 1; i <= 5; i++) {
            let name = this[`fav${i}Name`];
            let lat = parseFloat(this[`fav${i}Lat`]);
            let lon = parseFloat(this[`fav${i}Lon`]);
            if (name && name.trim() !== '' && !isNaN(lat) && !isNaN(lon))
                this._favorites.push({ name: name.trim(), lat, lon });
        }
        this._activeFavIndex = Math.min(
            Math.max(0, (this.defaultFavorite || 1) - 1),
            Math.max(0, this._favorites.length - 1)
        );
    }

    // ── UI Construction ──────────────────────────────────────
    _buildUI() {
        this._container = new St.BoxLayout({ vertical: true, style_class: 'simplewx-container' });

        // ·· Nav row ··
        let navRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-nav-row' });
        this._prevBtn = new St.Button({ label: '◀', style_class: 'simplewx-nav-btn' });
        this._prevBtn.connect('clicked', () => this._cycleLocation(-1));
        this._locationLabel = new St.Label({ text: 'Locating...', style_class: 'simplewx-location' });
        this._nextBtn = new St.Button({ label: '▶', style_class: 'simplewx-nav-btn' });
        this._nextBtn.connect('clicked', () => this._cycleLocation(1));
        navRow.add_child(this._prevBtn);
        navRow.add_child(this._locationLabel);
        navRow.add_child(this._nextBtn);

        // ·· Current conditions icon ··
        this._weatherIcon = new St.Icon({ icon_size: 72, style_class: 'simplewx-icon' });

        // ·· Temp row + info button ··
        let tempRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-temp-row' });
        this._tempLabel = new St.Label({ text: '--°F', style_class: 'simplewx-temp' });
        this._infoBtn = new St.Button({ label: 'ℹ', style_class: 'simplewx-info-btn' });
        this._infoBtn.connect('clicked', () => this._togglePopup());
        tempRow.add_child(this._tempLabel);
        tempRow.add_child(this._infoBtn);

        // ·· Condition / wind ··
        this._condLabel = new St.Label({ text: 'Fetching...', style_class: 'simplewx-condition' });
        this._windLabel = new St.Label({ text: '', style_class: 'simplewx-wind' });

        // ·· Detailed forecast popup (hidden by default) ··
        this._popupBox = new St.BoxLayout({ vertical: true, style_class: 'simplewx-popup', visible: false });
        this._popupLabel = new St.Label({ text: '', style_class: 'simplewx-popup-text' });
        this._popupLabel.clutter_text.line_wrap = true;
        this._popupLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._popupBox.add_child(this._popupLabel);

        // ·· 7-day forecast strip ··
        let forecastSection = new St.BoxLayout({ vertical: true, style_class: 'simplewx-forecast-section' });
        forecastSection.add_child(this._makeDivider());
        this._forecastRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-forecast-row' });
        this._dayCells = [];
        for (let i = 0; i < 7; i++) {
            let cell = this._makeDayCell();
            this._dayCells.push(cell);
            this._forecastRow.add_child(cell.container);
        }
        forecastSection.add_child(this._forecastRow);

        // ·· Ham radio space weather section ··
        this._spaceWxSection = new St.BoxLayout({ vertical: true, style_class: 'simplewx-spacewx-section' });
        this._spaceWxSection.add_child(this._makeDivider());

        // Row 1: K-index, SFI, X-ray class, Solar wind
        let spaceWxRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-spacewx-row' });

        // K-index block
        let kBlock = new St.BoxLayout({ vertical: true, style_class: 'simplewx-spacewx-block' });
        kBlock.add_child(new St.Label({ text: 'K-index', style_class: 'simplewx-spacewx-hdr' }));
        this._kIndexLabel = new St.Label({ text: '--', style_class: 'simplewx-kindex' });
        this._geoStateLabel = new St.Label({ text: '---', style_class: 'simplewx-geostate' });
        kBlock.add_child(this._kIndexLabel);
        kBlock.add_child(this._geoStateLabel);

        // SFI block
        let sfiBlock = new St.BoxLayout({ vertical: true, style_class: 'simplewx-spacewx-block' });
        sfiBlock.add_child(new St.Label({ text: 'SFI', style_class: 'simplewx-spacewx-hdr' }));
        this._sfiLabel = new St.Label({ text: '--', style_class: 'simplewx-sfi' });
        sfiBlock.add_child(this._sfiLabel);

        // X-ray flux class block
        let xrayBlock = new St.BoxLayout({ vertical: true, style_class: 'simplewx-spacewx-block' });
        xrayBlock.add_child(new St.Label({ text: 'X-Ray', style_class: 'simplewx-spacewx-hdr' }));
        this._xrayLabel = new St.Label({ text: '--', style_class: 'simplewx-xray' });
        xrayBlock.add_child(this._xrayLabel);

        // Solar wind block
        let windBlock = new St.BoxLayout({ vertical: true, style_class: 'simplewx-spacewx-block' });
        windBlock.add_child(new St.Label({ text: 'Sol Wind', style_class: 'simplewx-spacewx-hdr' }));
        this._solarWindLabel = new St.Label({ text: '-- km/s', style_class: 'simplewx-solwind' });
        windBlock.add_child(this._solarWindLabel);

        spaceWxRow.add_child(kBlock);
        spaceWxRow.add_child(sfiBlock);
        spaceWxRow.add_child(xrayBlock);
        spaceWxRow.add_child(windBlock);
        this._spaceWxSection.add_child(spaceWxRow);

        // Row 2: Band conditions strip
        this._spaceWxSection.add_child(this._makeDivider());
        let bandHdr = new St.Label({ text: 'Band Conditions', style_class: 'simplewx-spacewx-hdr' });
        this._spaceWxSection.add_child(bandHdr);

        this._bandRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-band-row' });
        this._bandCells = {};
        const BANDS = ['80m', '40m', '20m', '15m', '10m', '6m'];
        for (let band of BANDS) {
            let cell = new St.BoxLayout({ vertical: true, style_class: 'simplewx-band-cell' });
            let nameLabel = new St.Label({ text: band, style_class: 'simplewx-band-name' });
            let condLabel = new St.Label({ text: '?', style_class: 'simplewx-band-cond' });
            cell.add_child(nameLabel);
            cell.add_child(condLabel);
            this._bandCells[band] = condLabel;
            this._bandRow.add_child(cell);
        }
        this._spaceWxSection.add_child(this._bandRow);
        this._spaceWxSection.visible = this.showSpaceWx !== false;

        // ·· Assemble ··
        this._container.add_child(navRow);
        this._container.add_child(this._weatherIcon);
        this._container.add_child(tempRow);
        this._container.add_child(this._condLabel);
        this._container.add_child(this._windLabel);
        this._container.add_child(this._popupBox);
        this._container.add_child(forecastSection);
        this._container.add_child(this._spaceWxSection);

        this.setContent(this._container);
    }

    _makeDivider() {
        return new St.Label({ text: '', style_class: 'simplewx-divider' });
    }

    _makeDayCell() {
        let container = new St.BoxLayout({ vertical: true, style_class: 'simplewx-day-cell' });
        let dayLabel = new St.Label({ text: '---', style_class: 'simplewx-day-name' });
        let icon = new St.Icon({ icon_size: 32, style_class: 'simplewx-day-icon' });
        let tempLabel = new St.Label({ text: '--°', style_class: 'simplewx-day-temp' });
        container.add_child(dayLabel);
        container.add_child(icon);
        container.add_child(tempLabel);
        return { container, dayLabel, icon, tempLabel };
    }

    // ── Popup toggle ─────────────────────────────────────────
    _togglePopup() {
        this._popupVisible = !this._popupVisible;
        this._popupBox.visible = this._popupVisible;
        if (this._popupVisible && this._detailedForecast)
            this._popupLabel.set_text(this._detailedForecast);
    }

    // ── Location cycling ─────────────────────────────────────
    _cycleLocation(direction) {
        if (this._favorites.length === 0) return;
        this._usingGeolocation = false;
        this._activeFavIndex = (this._activeFavIndex + direction + this._favorites.length)
            % this._favorites.length;
        this._currentLocation = this._favorites[this._activeFavIndex];
        this._forecastUrl = null;
        this._forecastDailyUrl = null;
        this._locationLabel.set_text(this._currentLocation.name);
        this._fetchPoints();
    }

    // ── Weather startup ──────────────────────────────────────
    _startWeather() {
        this._forecastUrl = null;
        this._forecastDailyUrl = null;
        this._locationLabel.set_text('Locating...');
        this.useGeolocation ? this._geolocate() : this._useDefaultFavorite();
    }

    _geolocate() {
        this._httpGet(GEOLOCATION_URL, (json) => {
            if (json.status === 'success') {
                this._currentLocation = { name: `${json.city}, ${json.regionName}`, lat: json.lat, lon: json.lon };
                this._usingGeolocation = true;
                this._locationLabel.set_text(`📍 ${this._currentLocation.name}`);
                this._fetchPoints();
            } else {
                throw new Error(json.message || 'ip-api returned failure');
            }
        }, () => this._useDefaultFavorite());
    }

    _useDefaultFavorite() {
        this._usingGeolocation = false;
        if (this._favorites.length === 0) { this._setError('No favorites configured'); return; }
        this._currentLocation = this._favorites[this._activeFavIndex];
        this._locationLabel.set_text(this._currentLocation.name);
        this._fetchPoints();
    }

    // ── NWS fetching ─────────────────────────────────────────
    _fetchPoints() {
        if (!this._currentLocation) return;
        let { lat, lon } = this._currentLocation;
        let url = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
        this._httpGet(url, (json) => {
            this._forecastUrl = json.properties.forecastHourly;
            this._forecastDailyUrl = json.properties.forecast;
            this._fetchCurrentConditions();
            this._fetchDailyForecast();
        }, () => this._setError('NWS points lookup failed'));
    }

    _fetchCurrentConditions() {
        if (!this._forecastUrl) { this._fetchPoints(); return; }
        this._httpGet(this._forecastUrl, (json) => {
            this._updateDisplay(json.properties.periods[0]);
            this._scheduleRefresh();
        }, () => { this._setError('Current conditions unavailable'); this._scheduleRefresh(); });
    }

    _fetchDailyForecast() {
        if (!this._forecastDailyUrl) return;
        this._httpGet(this._forecastDailyUrl, (json) => {
            let periods = json.properties.periods;
            // Use the first daytime period's detailed forecast for the popup
            let firstDay = periods.find(p => p.isDaytime);
            if (firstDay && firstDay.detailedForecast)
                this._detailedForecast = firstDay.detailedForecast;
            if (this._popupVisible)
                this._popupLabel.set_text(this._detailedForecast);
            // Daytime periods only for the 7-day strip
            let days = periods.filter(p => p.isDaytime).slice(0, 7);
            this._updateDailyForecast(days);
        }, () => log('SimpleWx: 7-day forecast unavailable'));
    }

    // ── Space Weather ────────────────────────────────────────
    _fetchSpaceWeather() {
        // ·· K-index ··
        this._httpGet(NOAA_KINDEX_URL, (data) => {
            let latest = [...data].reverse().find(row => row.time_tag && !isNaN(parseFloat(row.Kp)));
            let kp = latest ? parseFloat(latest.Kp) : 0;
            this._currentKp = kp;
            let state = kpState(kp);
            this._kIndexLabel.set_text(kp.toFixed(1));
            this._kIndexLabel.set_style(`color: ${state.color}; font-weight: bold;`);
            this._geoStateLabel.set_text(state.label);
            this._geoStateLabel.set_style(`color: ${state.color};`);
            this._updateBandConditions();
        }, () => log('SimpleWx: K-index fetch failed'));

        // ·· Solar Flux Index ··
        this._httpGet(NOAA_FLUX_URL, (json) => {
            let entry = Array.isArray(json) ? json[json.length - 1] : json;
            let flux = parseInt(entry.flux) || 0;
            this._currentSfi = flux;
            this._sfiLabel.set_text(String(flux));
            let color = flux < 100 ? '#44cc44' : flux < 150 ? '#cccc00' : flux < 200 ? '#ff8800' : '#ff4400';
            this._sfiLabel.set_style(`color: ${color}; font-weight: bold;`);
            this._updateBandConditions();
        }, () => log('SimpleWx: SFI fetch failed'));

        // ·· X-ray flux class ··
        this._httpGet(NOAA_XRAY_URL, (json) => {
            let entry = Array.isArray(json) ? json[json.length - 1] : json;
            let xClass = entry.current_class || '--';
            this._xrayLabel.set_text(String(xClass));
            let color = '#44cc44';
            let letter = String(xClass).charAt(0).toUpperCase();
            if (letter === 'C') color = '#cccc00';
            else if (letter === 'M') color = '#ff8800';
            else if (letter === 'X') color = '#ff2200';
            this._xrayLabel.set_style(`color: ${color}; font-weight: bold;`);
        }, () => log('SimpleWx: X-ray fetch failed'));

        // ·· Solar wind speed ··
        this._httpGet(NOAA_WIND_URL, (data) => {
            // Debug on first load — remove after confirming structure
            log(`SimpleWx Wind sample: ${JSON.stringify(data.slice(-2))}`);
            // Expected: array of arrays [time_tag, density, speed, temperature]
            // Skip header row (index 0), get last valid entry
            let latest = [...data].reverse().find(row =>
                Array.isArray(row) && row.length >= 3 && !isNaN(parseFloat(row[2]))
            );
            if (latest) {
                let speed = Math.round(parseFloat(latest[2]));
                this._solarWindLabel.set_text(`${speed} km/s`);
                // Color: green < 400, yellow 400-600, orange 600-800, red > 800
                let color = speed < 400 ? '#44cc44' : speed < 600 ? '#cccc00' : speed < 800 ? '#ff8800' : '#ff2200';
                this._solarWindLabel.set_style(`color: ${color}; font-weight: bold;`);
            } else {
                this._solarWindLabel.set_text('-- km/s');
            }
        }, () => log('SimpleWx: Solar wind fetch failed'));

        // ·· Schedule next space wx refresh ··
        if (this._spaceWxTimer) Mainloop.source_remove(this._spaceWxTimer);
        this._spaceWxTimer = Mainloop.timeout_add_seconds(SPACE_WX_SECS, () => {
            this._fetchSpaceWeather();
            return false;
        });
    }

    _updateBandConditions() {
        let kp = this._currentKp;
        let sfi = this._currentSfi;
        if (sfi === 0) return; // not loaded yet

        const conditions = {
            '80m': this._hfCondition80(kp),
            '40m': this._hfCondition40(kp, sfi),
            '20m': this._hfConditionMid(kp, sfi, 90, 120),
            '15m': this._hfConditionHigh(kp, sfi, 110, 150),
            '10m': this._hfConditionHigh(kp, sfi, 130, 160),
            '6m': this._vhfCondition(kp, sfi),
        };

        const COLORS = {
            'Good': '#44cc44',
            'Fair': '#cccc00',
            'Poor': '#ff4400',
            'Aurora': '#aa44ff',  // VHF aurora enhancement — purple
        };

        for (let [band, cond] of Object.entries(conditions)) {
            let label = this._bandCells[band];
            if (!label) continue;
            label.set_text(cond);
            label.set_style(`color: ${COLORS[cond] || '#888888'}; font-weight: bold;`);
        }
    }

    // 80m: K-index dominated — low bands absorb badly during storms
    _hfCondition80(kp) {
        if (kp >= 5) return 'Poor';
        if (kp >= 3) return 'Fair';
        return 'Good';
    }

    // 40m: K-index + SFI both matter
    _hfCondition40(kp, sfi) {
        if (kp >= 5) return 'Poor';
        if (kp >= 4) return 'Fair';
        if (sfi >= 100 && kp <= 2) return 'Good';
        if (sfi >= 80) return 'Fair';
        return 'Poor';
    }

    // 20m / mid HF
    _hfConditionMid(kp, sfi, fairFloor, goodFloor) {
        if (kp >= 4) return 'Poor';
        if (sfi >= goodFloor) return 'Good';
        if (sfi >= fairFloor) return 'Fair';
        return 'Poor';
    }

    // 15m / 10m / high HF — heavily SFI dependent
    _hfConditionHigh(kp, sfi, fairFloor, goodFloor) {
        if (kp >= 4) return 'Poor';
        if (sfi >= goodFloor) return 'Good';
        if (sfi >= fairFloor) return 'Fair';
        return 'Poor';
    }

    // 6m VHF — aurora enhancement possible with high K
    _vhfCondition(kp, sfi) {
        if (kp >= 5) return 'Aurora';  // aurora scatter opportunity!
        if (sfi >= 150) return 'Good';
        if (sfi >= 120) return 'Fair';
        return 'Poor';
    }

    // ── Display updates ──────────────────────────────────────
    _updateDisplay(period) {
        let { temperature, temperatureUnit, shortForecast, isDaytime, windSpeed, windDirection } = period;
        let [temp, unit] = this._convertTemp(temperature, temperatureUnit);
        this._tempLabel.set_text(`${temp}°${unit}`);
        this._condLabel.set_text(shortForecast);
        this._windLabel.set_text(`Wind: ${windDirection} ${windSpeed}`);
        this._weatherIcon.set_gicon(Gio.icon_new_for_string(this._resolveIcon(shortForecast, isDaytime)));
    }

    _updateDailyForecast(periods) {
        periods.forEach((period, i) => {
            if (i >= 7) return;
            let cell = this._dayCells[i];
            // NWS period.name is "Monday", "Tuesday", etc. — abbreviate to 3 chars
            let dayName = period.name === 'Today' ? 'Now' : period.name.substring(0, 3);
            let [temp] = this._convertTemp(period.temperature, period.temperatureUnit);
            cell.dayLabel.set_text(dayName);
            cell.tempLabel.set_text(`${temp}°`);
            cell.icon.set_gicon(Gio.icon_new_for_string(this._resolveIcon(period.shortForecast, period.isDaytime)));
        });
    }

    _convertTemp(temp, unit) {
        if (this.units === 'C' && unit === 'F')
            return [Math.round((temp - 32) * 5 / 9), 'C'];
        return [temp, unit];
    }

    // ── Icon resolution ──────────────────────────────────────
    _resolveIcon(shortForecast, isDaytime) {
        const fc = shortForecast.toLowerCase();
        const tod = isDaytime ? 'day' : 'night';

        if (fc.includes('thunder'))
            return this._icon(`wx-${tod}-thunderstorm-72`, 'wx-thunderstorm-72');
        if (fc.includes('blizzard') || fc.includes('snow') || fc.includes('flurr'))
            return this._icon(`wx-${tod}-snow-72`, 'wx-snow-72');
        if (fc.includes('sleet') || fc.includes('ice pellet'))
            return this._icon(`wx-${tod}-sleet-72`, 'wx-sleet-72');
        if (fc.includes('freez'))
            return this._icon('wx-freezing-rain-72');
        if (fc.includes('shower') || fc.includes('drizzle') || fc.includes('rain')) {
            if (fc.includes('slight') || fc.includes('chance') || fc.includes('scattered') || fc.includes('iso'))
                return this._icon('wx-scattered-showers-72');
            return this._icon('wx-showers-72');
        }
        if (fc.includes('fog') || fc.includes('mist'))
            return this._icon(`wx-${tod}-fog-72`, 'wx-fog-72');
        if (fc.includes('haze') || fc.includes('smoke') || fc.includes('dust'))
            return this._icon(`wx-${tod}-haze-72`, 'wx-haze-72');
        if (fc.includes('windy') || fc.includes('breezy'))
            return this._icon('wx-windy-72');
        if (fc.includes('overcast'))
            return this._icon(`wx-${tod}-overcast-72`, 'wx-overcast-72');
        if (fc.includes('mostly cloudy') || fc.includes('considerable cloud'))
            return this._icon(`wx-${tod}-partly-cloudy-72`);
        if (fc.includes('partly cloudy') || fc.includes('partly sunny'))
            return this._icon(`wx-${tod}-partly-cloudy-72`);
        if (fc.includes('mostly clear') || fc.includes('mostly sunny') ||
            fc.includes('few clouds') || fc.includes('scattered clouds'))
            return this._icon(`wx-${tod}-scattered-clouds-72`);
        return this._icon(`wx-${tod}-clear-72`);
    }

    _icon(...names) {
        for (let name of names) {
            let path = `${this._assetsPath}/${name}.png`;
            if (GLib.file_test(path, GLib.FileTest.EXISTS)) return path;
        }
        return `${this._assetsPath}/${names[0]}.png`;
    }

    // ── Generic HTTP helper ───────────────────────────────────
    _httpGet(url, onSuccess, onError) {
        let session = new Soup.Session();
        let message = Soup.Message.new('GET', url);
        message.request_headers.append('User-Agent', USER_AGENT);
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                let bytes = session.send_and_read_finish(result);
                let json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                onSuccess(json);
            } catch (e) {
                log(`SimpleWx: HTTP error for ${url}: ${e}`);
                if (onError) onError(e);
            }
        });
    }

    // ── Refresh scheduling ───────────────────────────────────
    _scheduleRefresh() {
        if (this._refreshTimer) Mainloop.source_remove(this._refreshTimer);
        let seconds = Math.max(REFRESH_FLOOR_S, (this.refreshInterval || 30) * 60);
        this._refreshTimer = Mainloop.timeout_add_seconds(seconds, () => {
            if (this.useGeolocation && this._usingGeolocation) {
                this._geolocate();
            } else {
                this._fetchCurrentConditions();
                this._fetchDailyForecast();
            }
            return false;
        });
    }

    _setError(msg) {
        log(`SimpleWx ERROR: ${msg}`);
        this._condLabel.set_text('Weather unavailable');
        this._locationLabel.set_text('Error — check logs');
    }

    on_desklet_removed() {
        if (this._refreshTimer) { Mainloop.source_remove(this._refreshTimer); this._refreshTimer = null; }
        if (this._spaceWxTimer) { Mainloop.source_remove(this._spaceWxTimer); this._spaceWxTimer = null; }
    }
}

function main(metadata, desklet_id) {
    return new SimpleWxDesklet(metadata, desklet_id);
}