const { Desklet, Mainloop, Gio, Settings, St, Clutter, Pango, PRESSURE_HISTORY_MAX, windArrow, kpState, MX, GLib, Soup, USER_AGENT, REFRESH_FLOOR_S } = require("./desklet");


// ============================================================
export class SimpleWxDesklet extends Desklet.Desklet {

    constructor(metadata, desklet_id) {
        super(metadata, desklet_id);
        this._metadata = metadata;
        this._assetsPath = `${metadata.path}/assets`;
        this._forecastUrl = null;
        this._forecastDailyUrl = null;
        this._obsStationsUrl = null;
        this._refreshTimer = null;
        this._spaceWxTimer = null;
        this._currentLocation = null;
        this._favorites = [];
        this._activeFavIndex = 0;
        this._usingGeolocation = false;
        this._popupVisible = false;
        this._attrPopupVisible = false;
        this._detailedForecast = '';
        this._currentKp = 0;
        this._currentSfi = 0;
        this._pressureHistory = [];
        this._config = this._loadConfig();
        this._attributions = this._loadAttributions();
        this._disclaimer = this._loadDisclaimer();
        this._disclaimerVisible = false;
        this._currentElectronFlux = 0;
        this._currentProtonFlux = 0;
        this._currentWindSpeed = 0; // terrestrial, mph
        this._forecastTempSwing = 0;
        //
        this._buildUI();
        this._bindSettings(metadata, desklet_id);
        this._loadLocations();
        this._startWeather();
        this._fetchSpaceWeather();
        // Show disclaimer on first run until acknowledged
        if (!this.disclaimerAcknowledged) {
            Mainloop.timeout_add_seconds(2, () => {
                this._toggleDisclaimer();
                return false;
            });
        }
    }

    // ── Config / Attributions loaders ───────────────────────
    _loadConfig() {
        try {
            let file = Gio.File.new_for_path(`${this._metadata.path}/config.json`);
            let [, contents] = file.load_contents(null);
            return JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            log(`SimpleWx: Failed to load config.json: ${e}`);
            return { endpoints: {} };
        }
    }

    _loadDisclaimer() {
        try {
            let file = Gio.File.new_for_path(`${this._metadata.path}/disclaimer.json`);
            let [, contents] = file.load_contents(null);
            return JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            log(`SimpleWx: Failed to load disclaimer.json: ${e}`);
            return { sections: [] };
        }
    }

    _loadAttributions() {
        try {
            let file = Gio.File.new_for_path(`${this._metadata.path}/attributions.json`);
            let [, contents] = file.load_contents(null);
            return JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            log(`SimpleWx: Failed to load attributions.json: ${e}`);
            return { attributions: [] };
        }
    }

    _endpoint(key) {
        return (this._config.endpoints || {})[key] || '';
    }

    // ── Settings ─────────────────────────────────────────────
    _bindSettings(metadata, desklet_id) {
        this.settings = new Settings.DeskletSettings(this, metadata.uuid, desklet_id);
        this.settings.bind('use-geolocation', 'useGeolocation', this._onSettingsChanged.bind(this));
        this.settings.bind('units', 'units', this._onSettingsChanged.bind(this));
        this.settings.bind('refresh-interval', 'refreshInterval', this._onSettingsChanged.bind(this));
        this.settings.bind('default-favorite', 'defaultFavorite', null);
        this.settings.bind('show-space-wx', 'showSpaceWx', this._onVisibilityChanged.bind(this));
        this.settings.bind('show-band-conditions', 'showBandConds', this._onVisibilityChanged.bind(this));
        this.settings.bind('show-7day', 'show7Day', this._onVisibilityChanged.bind(this));
        this.settings.bind('disclaimer-acknowledged', 'disclaimerAcknowledged', null);
        // Border settings
        this.settings.bind('show-border', 'showBorder', this._onBorderChanged.bind(this));
        this.settings.bind('border-color', 'borderColor', this._onBorderChanged.bind(this));
        this.settings.bind('border-size', 'borderSize', this._onBorderChanged.bind(this));
        this.settings.bind('border-radius', 'borderRadius', this._onBorderChanged.bind(this));
        this.settings.bind('show-migraine', 'showMigraine', this._onVisibilityChanged.bind(this));
        for (let i = 1; i <= 5; i++) {
            this.settings.bind(`fav${i}-name`, `fav${i}Name`, null);
            this.settings.bind(`fav${i}-lat`, `fav${i}Lat`, null);
            this.settings.bind(`fav${i}-lon`, `fav${i}Lon`, null);
        }
    }

    _onSettingsChanged() { this._loadLocations(); this._startWeather(); }
    _onVisibilityChanged() {
        // Null guards protect against callbacks firing before buildUI completes
        if (this._spaceWxSection)
            this._spaceWxSection.visible = !!this.showSpaceWx;
        if (this._bandSection)
            this._bandSection.visible = !!this.showBandConds;
        if (this._forecastSection)
            this._forecastSection.visible = !!this.show7Day;
        if (this._migraineSection)
            this._migraineSection.visible = !!this.showMigraine;
    }

    _onBorderChanged() {
        if (this._container) this._applyBorder();
    }

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

    _applyBorder() {
        if (this.showBorder) {
            let size = Math.min(Math.max(parseInt(this.borderSize) || 1, 1), 5);
            let radius = Math.min(Math.max(parseInt(this.borderRadius) || 4, 0), 16);
            let color = this.borderColor || 'rgba(255,255,255,0.4)';
            this._container.set_style(`
            border: ${size}px solid ${color};
            border-radius: ${radius}px;
            padding: 10px;
        `);
        } else {
            this._container.set_style('border: none; padding: 10px;');
        }
    }

    // ── UI Construction ──────────────────────────────────────
    _buildUI() {
        this._container = new St.BoxLayout({ vertical: true, style_class: 'simplewx-container' });

        // ·· Header ··
        this._container.add_child(this._buildHeader());

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
        this._container.add_child(navRow);

        // ·· Current conditions icon ··
        //this._weatherIcon = new St.Icon({ icon_size: 72, style_class: 'simplewx-icon' });
        this._weatherIcon = new St.Icon({ icon_size: 72, style_class: 'simplewx-icon', x_align: Clutter.ActorAlign.CENTER, x_expand: true });
        this._container.add_child(this._weatherIcon);

        // ·· Temp row: current + High/Low + info button ··
        //let tempRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-temp-row' });
        let tempRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-temp-row', x_align: Clutter.ActorAlign.CENTER, x_expand: true });
        this._tempLabel = new St.Label({ text: '--°', style_class: 'simplewx-temp' });
        this._hiLoLabel = new St.Label({ text: '', style_class: 'simplewx-hilo' });
        this._infoBtn = new St.Button({ label: 'ℹ', style_class: 'simplewx-info-btn' });
        this._infoBtn.connect('clicked', () => this._togglePopup());
        tempRow.add_child(this._tempLabel);
        tempRow.add_child(this._hiLoLabel);
        tempRow.add_child(this._infoBtn);
        this._container.add_child(tempRow);

        // ·· Condition + wind row ··
        //this._condLabel = new St.Label({ text: 'Fetching...', style_class: 'simplewx-condition' });
        this._condLabel = new St.Label({ text: 'Fetching...', style_class: 'simplewx-condition', x_align: Clutter.ActorAlign.CENTER, x_expand: true });
        this._container.add_child(this._condLabel);

        //let windRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-wind-row' });
        let windRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-wind-row', x_align: Clutter.ActorAlign.CENTER, x_expand: true });
        this._windArrowLabel = new St.Label({ text: '', style_class: 'simplewx-wind-arrow' });
        this._windLabel = new St.Label({ text: '', style_class: 'simplewx-wind' });
        windRow.add_child(this._windArrowLabel);
        windRow.add_child(this._windLabel);
        this._container.add_child(windRow);

        // ·· Pressure row ··
        //let pressRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-press-row' });
        let pressRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-press-row', x_align: Clutter.ActorAlign.CENTER, x_expand: true });
        this._pressLabel = new St.Label({ text: '', style_class: 'simplewx-pressure' });
        this._pressTrend = new St.Label({ text: '', style_class: 'simplewx-pressure-trend' });
        pressRow.add_child(this._pressLabel);
        pressRow.add_child(this._pressTrend);
        this._container.add_child(pressRow);

        // ·· Sunrise / Sunset row ··
        //let sunRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-sun-row' });
        let sunRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-sun-row', x_align: Clutter.ActorAlign.CENTER, x_expand: true });
        this._sunriseLabel = new St.Label({ text: '', style_class: 'simplewx-sun' });
        this._sunsetLabel = new St.Label({ text: '', style_class: 'simplewx-sun' });
        sunRow.add_child(this._sunriseLabel);
        sunRow.add_child(this._sunsetLabel);
        this._container.add_child(sunRow);

        // ·· Detailed forecast popup ··
        this._popupBox = new St.BoxLayout({ vertical: true, style_class: 'simplewx-popup', visible: false });
        this._popupLabel = new St.Label({ text: '', style_class: 'simplewx-popup-text' });
        this._popupLabel.clutter_text.line_wrap = true;
        this._popupLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._popupBox.add_child(this._popupLabel);
        this._container.add_child(this._popupBox);

        // ·· 7-day forecast strip ··
        this._forecastSection = new St.BoxLayout({ vertical: true, style_class: 'simplewx-forecast-section' });
        this._forecastSection.add_child(this._makeDivider());
        this._forecastRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-forecast-row' });
        this._dayCells = [];
        for (let i = 0; i < 7; i++) {
            let cell = this._makeDayCell();
            this._dayCells.push(cell);
            this._forecastRow.add_child(cell.container);
        }
        this._forecastSection.add_child(this._forecastRow);
        this._forecastSection.visible = this.show7Day !== false;
        this._container.add_child(this._forecastSection);

        // ·· Space weather section ··
        this._spaceWxSection = new St.BoxLayout({ vertical: true, style_class: 'simplewx-spacewx-section' });
        this._spaceWxSection.add_child(this._makeDivider());
        this._spaceWxSection.add_child(
            new St.Label({ text: 'Space Weather', style_class: 'simplewx-section-hdr' })
        );

        let spaceWxRow = new St.BoxLayout({
            vertical: false,
            style_class: 'simplewx-spacewx-row',
            y_align: Clutter.ActorAlign.START
        });

        let kBlock = this._makeSpaceBlock('K-index');
        this._kIndexLabel = new St.Label({ text: '--', style_class: 'simplewx-kindex' });
        this._geoStateLabel = new St.Label({ text: '---', style_class: 'simplewx-geostate' });
        kBlock.add_child(this._kIndexLabel);
        kBlock.add_child(this._geoStateLabel);

        let sfiBlock = this._makeSpaceBlock('SFI');
        this._sfiLabel = new St.Label({ text: '--', style_class: 'simplewx-sfi' });
        sfiBlock.add_child(this._sfiLabel);

        let xrayBlock = this._makeSpaceBlock('X-Ray');
        this._xrayLabel = new St.Label({ text: '--', style_class: 'simplewx-xray' });
        xrayBlock.add_child(this._xrayLabel);

        let windBlock = this._makeSpaceBlock('Sol Wind');
        this._solarWindLabel = new St.Label({ text: '-- km/s', style_class: 'simplewx-solwind' });
        windBlock.add_child(this._solarWindLabel);

        // ·· New: Electron flux ··
        let eBlock = this._makeSpaceBlock('e- Flux');
        this._electronLabel = new St.Label({ text: '--', style_class: 'simplewx-particle' });
        eBlock.add_child(this._electronLabel);
        //eBlock.set_style('margin-top: -8px;');
        // ·· New: Proton flux ··
        let pBlock = this._makeSpaceBlock('p+ Flux');
        this._protonLabel = new St.Label({ text: '--', style_class: 'simplewx-particle' });
        pBlock.add_child(this._protonLabel);
        //pBlock.set_style('margin-top: -8px;');
        spaceWxRow.add_child(kBlock);
        spaceWxRow.add_child(sfiBlock);
        spaceWxRow.add_child(xrayBlock);
        spaceWxRow.add_child(windBlock);
        spaceWxRow.add_child(eBlock);
        spaceWxRow.add_child(pBlock);
        this._spaceWxSection.add_child(spaceWxRow);
        this._spaceWxSection.visible = this.showSpaceWx !== false;
        this._container.add_child(this._spaceWxSection);

        // ·· Band conditions section ··
        this._bandSection = new St.BoxLayout({ vertical: true, style_class: 'simplewx-band-section' });
        this._bandSection.add_child(this._makeDivider());
        this._bandSection.add_child(
            new St.Label({ text: 'Band Conditions', style_class: 'simplewx-section-hdr' })
        );
        this._bandRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-band-row' });
        this._bandCells = {};
        for (let band of ['80m', '40m', '20m', '15m', '10m', '6m']) {
            let cell = new St.BoxLayout({ vertical: true, style_class: 'simplewx-band-cell' });
            let nameLabel = new St.Label({ text: band, style_class: 'simplewx-band-name' });
            let condLabel = new St.Label({ text: '?', style_class: 'simplewx-band-cond' });
            cell.add_child(nameLabel);
            cell.add_child(condLabel);
            this._bandCells[band] = condLabel;
            this._bandRow.add_child(cell);
        }
        this._bandSection.add_child(this._bandRow);
        this._bandSection.visible = this.showBandConds !== false;
        this._container.add_child(this._bandSection);

        // ·· Migraine indicator section ··
        this._migraineSection = new St.BoxLayout({ vertical: true, style_class: 'simplewx-migraine-section' });
        this._migraineSection.add_child(this._makeDivider());

        let mxHeaderRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-mx-header-row', x_align: Clutter.ActorAlign.CENTER, x_expand: true });
        mxHeaderRow.add_child(new St.Label({ text: '⚡ Migraine Index', style_class: 'simplewx-section-hdr' }));
        this._migraineSection.add_child(mxHeaderRow);

        let mxRow = new St.BoxLayout({ vertical: false, style_class: 'simplewx-mx-row', x_align: Clutter.ActorAlign.CENTER, x_expand: true });
        this._mxIndicatorLabel = new St.Label({ text: 'Calculating...', style_class: 'simplewx-mx-indicator' });
        this._mxScoreLabel = new St.Label({ text: '', style_class: 'simplewx-mx-score' });
        mxRow.add_child(this._mxIndicatorLabel);
        mxRow.add_child(this._mxScoreLabel);
        this._migraineSection.add_child(mxRow);

        // Factor breakdown row
        this._mxFactorsLabel = new St.Label({ text: '', style_class: 'simplewx-mx-factors', x_align: Clutter.ActorAlign.CENTER, x_expand: true });
        this._mxFactorsLabel.clutter_text.line_wrap = true;
        this._mxFactorsLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._migraineSection.add_child(this._mxFactorsLabel);
        this._container.add_child(this._migraineSection);


        // ·· Attributions popup ··
        this._attrPopupBox = new St.BoxLayout({ vertical: true, style_class: 'simplewx-popup simplewx-attr-popup', visible: false });
        this._attrContent = new St.Label({ text: '', style_class: 'simplewx-popup-text' });
        this._attrContent.clutter_text.line_wrap = true;
        this._attrContent.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._attrPopupBox.add_child(this._attrContent);
        this._container.add_child(this._attrPopupBox);

        // ·· Disclaimer popup ··
        this._disclaimerPopupBox = new St.BoxLayout({
            vertical: true,
            style_class: 'simplewx-popup simplewx-disclaimer-popup',
            visible: false
        });

        // Acknowledgment banner — shown on first run only
        this._disclaimerBanner = new St.BoxLayout({
            vertical: false,
            style_class: 'simplewx-disclaimer-banner',
            visible: !this.disclaimerAcknowledged
        });
        let bannerLabel = new St.Label({
            text: '⚠  Please read and acknowledge this disclaimer to continue  ',
            style_class: 'simplewx-disclaimer-banner-text'
        });
        let ackBtn = new St.Button({ label: '✓  I Understand', style_class: 'simplewx-ack-btn' });
        ackBtn.connect('clicked', () => {
            this.disclaimerAcknowledged = true;
            this.settings.setValue('disclaimer-acknowledged', true);
            this._disclaimerBanner.visible = false;
            this._disclaimerPopupBox.visible = false;
            this._disclaimerVisible = false;
        });
        this._disclaimerBanner.add_child(bannerLabel);
        this._disclaimerBanner.add_child(ackBtn);

        this._disclaimerContent = new St.Label({
            text: '',
            style_class: 'simplewx-popup-text simplewx-disclaimer-text'
        });
        this._disclaimerContent.clutter_text.line_wrap = true;
        this._disclaimerContent.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;

        this._disclaimerPopupBox.add_child(this._disclaimerBanner);
        this._disclaimerPopupBox.add_child(this._disclaimerContent);
        this._container.add_child(this._disclaimerPopupBox);

        // ·· Footer ··
        this._container.add_child(this._buildFooter());

        this.setContent(this._container);
        this._applyBorder();
    }

    _toggleDisclaimer() {
        this._disclaimerVisible = !this._disclaimerVisible;
        this._disclaimerPopupBox.visible = this._disclaimerVisible;
        if (this._disclaimerVisible) {
            this._disclaimerContent.set_text(this._buildDisclaimerText());
            this._disclaimerBanner.visible = !this.disclaimerAcknowledged;
            // Close other popups
            if (this._popupVisible) this._togglePopup();
            if (this._attrPopupVisible) this._toggleAttributions();
        }
    }

    _buildDisclaimerText() {
        let lines = [];
        for (let section of (this._disclaimer.sections || [])) {
            lines.push(`── ${section.title} ──`);
            lines.push(section.content);
        }
        return lines.join('\n\n') || 'No disclaimer data found.';
    }

    _buildHeader() {
        //let row = new St.BoxLayout({ vertical: false, style_class: 'simplewx-header-row' });
        let row = new St.BoxLayout({ vertical: false, style_class: 'simplewx-header-row', x_align: Clutter.ActorAlign.END, x_expand: true });
        let title = new St.Label({ text: 'Simple WX by ', style_class: 'simplewx-header-title' });
        let callBtn = new St.Button({ label: 'WD8TA', style_class: 'simplewx-header-link' });
        callBtn.connect('clicked', () => {
            Gio.AppInfo.launch_default_for_uri('https://www.qrz.com/db/WD8TA', null);
        });
        row.add_child(title);
        row.add_child(callBtn);
        return row;
    }

    /*    _buildFooter() {
           let col = new St.BoxLayout({ vertical: true, style_class: 'simplewx-footer-col' });
   
           let row = new St.BoxLayout({ vertical: false, style_class: 'simplewx-footer-row', x_align: Clutter.ActorAlign.CENTER, x_expand: true });
           let copy = new St.Label({ text: 'Copyright 2026 - WD8TA  ', style_class: 'simplewx-footer-text' });
           let attrBtn = new St.Button({ label: 'Attributions', style_class: 'simplewx-footer-link' });
           attrBtn.connect('clicked', () => this._toggleAttributions());
           row.add_child(copy);
           row.add_child(attrBtn);
   
           this._lastUpdatedLabel = new St.Label({
               text: '',
               style_class: 'simplewx-last-updated',
               x_align: Clutter.ActorAlign.CENTER,
               x_expand: true
           });
   
           col.add_child(row);
           col.add_child(this._lastUpdatedLabel);
           return col;
       } */
    _buildFooter() {
        let col = new St.BoxLayout({ vertical: true, style_class: 'simplewx-footer-col' });

        let row = new St.BoxLayout({
            vertical: false,
            style_class: 'simplewx-footer-row',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true
        });
        let copy = new St.Label({ text: 'Copyright 2026 - WD8TA  ', style_class: 'simplewx-footer-text' });
        let attrBtn = new St.Button({ label: 'Attributions', style_class: 'simplewx-footer-link' });
        attrBtn.connect('clicked', () => this._toggleAttributions());

        let sep = new St.Label({ text: '  |  ', style_class: 'simplewx-footer-text' });

        let discBtn = new St.Button({ label: 'Disclaimer', style_class: 'simplewx-footer-link' });
        discBtn.connect('clicked', () => this._toggleDisclaimer());

        row.add_child(copy);
        row.add_child(attrBtn);
        row.add_child(sep);
        row.add_child(discBtn);

        this._lastUpdatedLabel = new St.Label({
            text: '',
            style_class: 'simplewx-last-updated',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true
        });

        col.add_child(row);
        col.add_child(this._lastUpdatedLabel);
        return col;
    }

    _makeDivider() {
        return new St.Label({ text: '', style_class: 'simplewx-divider' });
    }

    _makeSpaceBlock(title) {
        let block = new St.BoxLayout({ vertical: true, style_class: 'simplewx-spacewx-block' });
        block.add_child(new St.Label({ text: title, style_class: 'simplewx-spacewx-hdr' }));
        return block;
    }

    _makeDayCell() {
        let container = new St.BoxLayout({ vertical: true, style_class: 'simplewx-day-cell' });
        let dayLabel = new St.Label({ text: '---', style_class: 'simplewx-day-name' });
        let icon = new St.Icon({ icon_size: 32, style_class: 'simplewx-day-icon' });
        let hiLoLabel = new St.Label({ text: '--/--', style_class: 'simplewx-day-hilo' });
        let windLabel = new St.Label({ text: '', style_class: 'simplewx-day-wind' });
        container.add_child(dayLabel);
        container.add_child(icon);
        container.add_child(hiLoLabel);
        container.add_child(windLabel);
        return { container, dayLabel, icon, hiLoLabel, windLabel };
    }

    // ── Popups ───────────────────────────────────────────────
    _togglePopup() {
        this._popupVisible = !this._popupVisible;
        this._popupBox.visible = this._popupVisible;
        if (this._popupVisible && this._detailedForecast)
            this._popupLabel.set_text(this._detailedForecast);
        // close attributions if open
        if (this._popupVisible && this._attrPopupVisible) this._toggleAttributions();
    }

    _toggleAttributions() {
        this._attrPopupVisible = !this._attrPopupVisible;
        this._attrPopupBox.visible = this._attrPopupVisible;
        if (this._attrPopupVisible)
            this._attrContent.set_text(this._buildAttributionText());
        // close forecast popup if open
        if (this._attrPopupVisible && this._popupVisible) this._togglePopup();
    }

    _buildAttributionText() {
        let lines = [];
        for (let cat of (this._attributions.attributions || [])) {
            lines.push(`── ${cat.category} ──`);
            for (let item of (cat.items || []))
                lines.push(`${item.name}\n  ${item.author} | ${item.license}\n  ${item.source}`);
        }
        return lines.join('\n\n') || 'No attribution data found.';
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
        this._obsStationsUrl = null;
        this._locationLabel.set_text(this._currentLocation.name);
        this._fetchPoints();
    }

    _updateLastUpdated() {
        let now = new Date();
        let month = (now.getMonth() + 1).toString().padStart(2, '0');
        let day = now.getDate().toString().padStart(2, '0');
        let year = now.getFullYear();
        let hours = now.getHours();
        let mins = now.getMinutes().toString().padStart(2, '0');
        let ampm = hours >= 12 ? 'PM' : 'AM';
        hours = (hours % 12 || 12).toString().padStart(2, '0');
        this._lastUpdatedLabel.set_text(
            `Last Updated ${month}/${day}/${year} @ ${hours}:${mins}${ampm}`
        );
    }

    // ── Weather startup ──────────────────────────────────────
    _startWeather() {
        this._forecastUrl = null;
        this._forecastDailyUrl = null;
        this._obsStationsUrl = null;
        this._locationLabel.set_text('Locating...');
        this.useGeolocation ? this._geolocate() : this._useDefaultFavorite();
    }

    _geolocate() {
        this._httpGet(this._endpoint('geolocation'), (json) => {
            if (json.status === 'success') {
                this._currentLocation = { name: `${json.city}, ${json.regionName}`, lat: json.lat, lon: json.lon };
                this._usingGeolocation = true;
                this._locationLabel.set_text(`📍 ${this._currentLocation.name}`);
                this._fetchPoints();
            } else throw new Error(json.message || 'ip-api failure');
        }, () => this._useDefaultFavorite());
    }

    _useDefaultFavorite() {
        this._usingGeolocation = false;
        if (this._favorites.length === 0) { this._setError('No favorites configured'); return; }
        this._currentLocation = this._favorites[this._activeFavIndex];
        this._locationLabel.set_text(this._currentLocation.name);
        this._fetchPoints();
    }

    // ── NWS fetch chain ──────────────────────────────────────
    _fetchPoints() {
        if (!this._currentLocation) return;
        let { lat, lon } = this._currentLocation;
        let url = this._endpoint('nws_points')
            .replace('{lat}', lat.toFixed(4))
            .replace('{lon}', lon.toFixed(4));

        this._httpGet(url, (json) => {
            this._forecastUrl = json.properties.forecastHourly;
            this._forecastDailyUrl = json.properties.forecast;
            this._obsStationsUrl = json.properties.observationStations;
            this._fetchCurrentConditions();
            this._fetchDailyForecast();
            this._fetchCurrentObservation();
            this._updateSunriseSunset();
        }, () => this._setError('NWS points lookup failed'));
    }

    _fetchCurrentConditions() {
        if (!this._forecastUrl) { this._fetchPoints(); return; }
        this._httpGet(this._forecastUrl, (json) => {
            this._updateDisplay(json.properties.periods[0]);
            this._updateLastUpdated();
            this._scheduleRefresh();
        }, () => { this._setError('Current conditions unavailable'); this._scheduleRefresh(); });
    }

    _fetchDailyForecast() {
        if (!this._forecastDailyUrl) return;
        this._httpGet(this._forecastDailyUrl, (json) => {
            let periods = json.properties.periods;
            // Populate detailed forecast popup from first daytime period
            let firstDay = periods.find(p => p.isDaytime);
            if (firstDay) this._detailedForecast = firstDay.detailedForecast || '';
            if (this._popupVisible) this._popupLabel.set_text(this._detailedForecast);
            this._updateDailyForecast(periods);
        }, () => log('SimpleWx: 7-day forecast unavailable'));
    }

    // ── Observation chain (pressure) ─────────────────────────
    // NWS: /points → observationStations URL → first station → /observations/latest
    _fetchCurrentObservation() {
        if (!this._obsStationsUrl) return;
        this._httpGet(this._obsStationsUrl, (json) => {
            let stations = json.features || [];
            if (stations.length === 0) return;
            // Use first station — closest to the grid point
            let stationUrl = stations[0].id + '/observations/latest';
            this._fetchPressure(stationUrl);
        }, () => log('SimpleWx: Observation stations lookup failed'));
    }

    _fetchPressure(stationUrl) {
        this._httpGet(stationUrl, (json) => {
            let props = json.properties || {};
            let baro = props.barometricPressure;
            if (baro && baro.value !== null) {
                // NWS returns Pa — convert to inHg
                let inHg = baro.value / 3386.39;
                this._recordPressure(inHg);
                let trend = this._pressureTrend();
                this._pressLabel.set_text(`⊙ ${inHg.toFixed(2)} inHg`);
                this._pressTrend.set_text(trend.symbol);
                this._pressTrend.set_style(`color: ${trend.color};`);
            } else {
                this._pressLabel.set_text('');
            }
        }, () => log('SimpleWx: Pressure observation fetch failed'));
    }

    _recordPressure(inHg) {
        this._pressureHistory.push({ val: inHg, ts: Date.now() });
        if (this._pressureHistory.length > PRESSURE_HISTORY_MAX)
            this._pressureHistory.shift();
    }

    _pressureTrend() {
        if (this._pressureHistory.length < 2)
            return { symbol: '=', color: '#aaaaaa' };
        let oldest = this._pressureHistory[0].val;
        let newest = this._pressureHistory[this._pressureHistory.length - 1].val;
        let delta = newest - oldest;
        if (delta > 0.03) return { symbol: '↑', color: '#44cc44' };
        if (delta < -0.03) return { symbol: '↓', color: '#ff6644' };
        return { symbol: '=', color: '#aaaaaa' };
    }

    // ── Sunrise / Sunset calculation ─────────────────────────
    // NOAA simplified solar algorithm — no API call needed
    _updateSunriseSunset() {
        if (!this._currentLocation) return;
        let { lat, lon } = this._currentLocation;
        let times = this._calcSunriseSunset(lat, lon, new Date());
        this._sunriseLabel.set_text(`🌅 ${times.sunrise}`);
        this._sunsetLabel.set_text(`  🌇 ${times.sunset}`);
    }

    _calcSunriseSunset(lat, lon, date) {
        const toRad = d => d * Math.PI / 180;
        const toDeg = r => r * 180 / Math.PI;

        let jd = Math.floor(date.getTime() / 86400000) + 2440587.5;
        let n = jd - 2451545.0;

        let L = (280.460 + 0.9856474 * n) % 360;
        let g = toRad((357.528 + 0.9856003 * n) % 360);
        let lambda = toRad(L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
        let eps = toRad(23.439 - 0.0000004 * n);
        let sinDec = Math.sin(eps) * Math.sin(lambda);
        let dec = Math.asin(sinDec);

        let HA = toDeg(Math.acos(
            (Math.sin(toRad(-0.833)) - Math.sin(toRad(lat)) * sinDec) /
            (Math.cos(toRad(lat)) * Math.cos(dec))
        ));

        let noon = 12.0 - (lon / 15.0) - ((n % 1) * 24 - 12);
        let rise = noon - HA / 15.0;
        let set = noon + HA / 15.0;

        // Adjust for local timezone offset
        let tzOffset = -date.getTimezoneOffset() / 60;
        rise += tzOffset;
        set += tzOffset;

        return {
            sunrise: this._decimalToTime(((rise % 24) + 24) % 24),
            sunset: this._decimalToTime(((set % 24) + 24) % 24)
        };
    }

    _decimalToTime(decimal) {
        let h = Math.floor(decimal);
        let m = Math.round((decimal - h) * 60);
        if (m === 60) { h++; m = 0; }
        let ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return `${h}:${m.toString().padStart(2, '0')} ${ampm}`;
    }

    // ── Display updates ──────────────────────────────────────
    _updateDisplay(period) {
        let { temperature, temperatureUnit, shortForecast, isDaytime, windSpeed, windDirection } = period;
        let [temp, unit] = this._convertTemp(temperature, temperatureUnit);
        this._tempLabel.set_text(`${temp}°${unit}`);
        this._condLabel.set_text(shortForecast);
        this._windArrowLabel.set_text(windArrow(windDirection));
        this._windLabel.set_text(` ${windDirection} ${windSpeed}`);
        // Parse wind speed for migraine model — NWS returns "10 mph" or "10 to 15 mph"
        let speedMatch = (windSpeed || '').match(/(\d+)\s*(?:to\s*(\d+))?\s*mph/i);
        if (speedMatch) {
            this._currentWindSpeed = parseInt(speedMatch[2] || speedMatch[1]);
            this._updateMigraineIndicator();
        }
        this._weatherIcon.set_gicon(
            Gio.icon_new_for_string(this._resolveIcon(shortForecast, isDaytime))
        );
    }

    _updateDailyForecast(periods) {
        // Pair daytime/nighttime periods: daytime = high, nighttime = low
        let pairs = [];
        for (let i = 0; i < periods.length && pairs.length < 7; i++) {
            if (!periods[i].isDaytime) continue;
            let night = periods[i + 1] && !periods[i + 1].isDaytime ? periods[i + 1] : null;
            pairs.push({ day: periods[i], night });
        }

        pairs.forEach((pair, i) => {
            let cell = this._dayCells[i];
            let dayName = this._normalizeDayName(pair.day.name);
            let [hi] = this._convertTemp(pair.day.temperature, pair.day.temperatureUnit);
            let loText = '--';
            if (pair.night) {
                let [lo] = this._convertTemp(pair.night.temperature, pair.night.temperatureUnit);
                loText = String(lo);
            }
            cell.dayLabel.set_text(dayName);
            cell.hiLoLabel.set_text(`↑${hi}° ↓${loText}°`);
            let arrow = windArrow(pair.day.windDirection || '');
            cell.windLabel.set_text(`${arrow} ${pair.day.windSpeed || ''}`);
            cell.icon.set_gicon(
                Gio.icon_new_for_string(this._resolveIcon(pair.day.shortForecast, true))
            );
        });

        // Update today's high/low in current conditions row
        if (pairs.length > 0) {
            let [hi] = this._convertTemp(pairs[0].day.temperature, pairs[0].day.temperatureUnit);
            let loText = '--';
            if (pairs[0].night) {
                let [lo] = this._convertTemp(pairs[0].night.temperature, pairs[0].night.temperatureUnit);
                loText = String(lo);
            }
            this._hiLoLabel.set_text(` ↑${hi}° ↓${loText}°`);
        }

        // Temperature swing = today high minus tonight low
        if (pairs.length > 0) {
            let [hi] = this._convertTemp(pairs[0].day.temperature, pairs[0].day.temperatureUnit);
            if (pairs[0].night) {
                let [lo] = this._convertTemp(pairs[0].night.temperature, pairs[0].night.temperatureUnit);
                this._forecastTempSwing = Math.abs(hi - lo);
                this._updateMigraineIndicator();
            }
        }
    }

    _normalizeDayName(name) {
        // NWS special period names → real day abbreviation
        const SPECIAL = ['Today', 'This Morning', 'This Afternoon', 'Tonight', 'Overnight'];
        if (SPECIAL.some(s => name.startsWith(s))) {
            return new Date().toLocaleDateString('en-US', { weekday: 'short' });
        }
        return name.substring(0, 3);
    }
    _convertTemp(temp, unit) {
        if (this.units === 'C' && unit === 'F')
            return [Math.round((temp - 32) * 5 / 9), 'C'];
        return [temp, unit];
    }

    // ── Space weather ────────────────────────────────────────
    _fetchSpaceWeather() {
        this._httpGet(this._endpoint('noaa_kindex'), (data) => {
            let latest = [...data].reverse().find(r => r.time_tag && !isNaN(parseFloat(r.Kp)));
            let kp = latest ? parseFloat(latest.Kp) : 0;
            this._currentKp = kp;
            let state = kpState(kp);
            this._kIndexLabel.set_text(kp.toFixed(1));
            this._kIndexLabel.set_style(`color: ${state.color}; font-weight: bold;`);
            this._geoStateLabel.set_text(state.label);
            this._geoStateLabel.set_style(`color: ${state.color};`);
            this._updateBandConditions();
            this._updateLastUpdated();
        }, () => log('SimpleWx: K-index fetch failed'));

        this._httpGet(this._endpoint('noaa_flux'), (json) => {
            let entry = Array.isArray(json) ? json[json.length - 1] : json;
            let flux = parseInt(entry.flux) || 0;
            this._currentSfi = flux;
            this._sfiLabel.set_text(String(flux));
            let color = flux < 100 ? '#44cc44' : flux < 150 ? '#cccc00' : flux < 200 ? '#ff8800' : '#ff4400';
            this._sfiLabel.set_style(`color: ${color}; font-weight: bold;`);
            this._updateBandConditions();
        }, () => log('SimpleWx: SFI fetch failed'));

        this._httpGet(this._endpoint('noaa_xray'), (json) => {
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

        this._httpGet(this._endpoint('noaa_wind'), (data) => {
            let latest = [...data].reverse().find(r => Array.isArray(r) && r.length >= 3 && !isNaN(parseFloat(r[2]))
            );
            if (latest) {
                let speed = Math.round(parseFloat(latest[2]));
                this._solarWindLabel.set_text(`${speed} km/s`);
                let color = speed < 400 ? '#44cc44' : speed < 600 ? '#cccc00' : speed < 800 ? '#ff8800' : '#ff2200';
                this._solarWindLabel.set_style(`color: ${color}; font-weight: bold;`);
            }
        }, () => log('SimpleWx: Solar wind fetch failed'));

        // ·· Electron flux ··
        this._httpGet(this._endpoint('noaa_electrons'), (data) => {
            if (!Array.isArray(data) || data.length === 0) return;

            // Get the most recent timestamp
            let latest = data[data.length - 1];
            let latestTime = latest.time_tag;

            // Filter to 79 keV channel at latest timestamp only
            let channel = [...data]
                .reverse()
                .find(r => r.time_tag === latestTime &&
                    r.energy && r.energy.includes('79') &&
                    !isNaN(parseFloat(r.flux)));

            if (channel) {
                let flux = parseFloat(channel.flux);
                this._currentElectronFlux = flux;
                let displayVal = flux >= 1000
                    ? `${(flux / 1000).toFixed(1)}k`
                    : String(Math.round(flux));
                this._electronLabel.set_text(displayVal);
                let color = flux < MX.ELECTRON_ELEVATED
                    ? '#44cc44'
                    : flux < MX.ELECTRON_ELEVATED * 10
                        ? '#cccc00'
                        : '#ff4400';
                this._electronLabel.set_style(`color: ${color}; font-weight: bold;`);
                this._updateMigraineIndicator();
            }
        }, () => log('SimpleWx: Electron flux fetch failed'));

        // ·· Proton flux ··
        this._httpGet(this._endpoint('noaa_protons'), (data) => {
            if (!Array.isArray(data) || data.length === 0) return;

            // Get most recent timestamp
            let latest = data[data.length - 1];
            let latestTime = latest.time_tag;

            // >=10 MeV is the NOAA S-scale reference channel
            let channel = [...data]
                .reverse()
                .find(r => r.time_tag === latestTime &&
                    r.energy && r.energy.includes('10 MeV') &&
                    !isNaN(parseFloat(r.flux)));

            if (channel) {
                let flux = parseFloat(channel.flux);
                this._currentProtonFlux = flux;
                // Proton flux displays with 2 decimal places — values are small
                this._protonLabel.set_text(flux.toFixed(2));
                // NOAA S1 storm threshold is 10 pfu
                let color = flux < 1 ? '#44cc44'
                    : flux < 10 ? '#cccc00'
                        : flux < 100 ? '#ff8800'
                            : '#ff2200';
                this._protonLabel.set_style(`color: ${color}; font-weight: bold;`);
                this._updateMigraineIndicator();
            }
        }, () => log('SimpleWx: Proton flux fetch failed'));
    }

    // ── Band conditions ──────────────────────────────────────
    _updateBandConditions() {
        let kp = this._currentKp, sfi = this._currentSfi;
        if (sfi === 0) return;
        const conditions = {
            '80m': this._cond80(kp),
            '40m': this._cond40(kp, sfi),
            '20m': this._condMid(kp, sfi, 90, 120),
            '15m': this._condHigh(kp, sfi, 110, 150),
            '10m': this._condHigh(kp, sfi, 130, 160),
            '6m': this._condVhf(kp, sfi),
        };
        const COLORS = { 'Good': '#44cc44', 'Fair': '#cccc00', 'Poor': '#ff4400', 'Aurora': '#aa44ff' };
        for (let [band, cond] of Object.entries(conditions)) {
            let lbl = this._bandCells[band];
            if (!lbl) continue;
            lbl.set_text(cond);
            lbl.set_style(`color: ${COLORS[cond] || '#888888'}; font-weight: bold;`);
        }
    }

    _cond80(kp) { return kp >= 5 ? 'Poor' : kp >= 3 ? 'Fair' : 'Good'; }
    _cond40(kp, sfi) { if (kp >= 5) return 'Poor'; if (kp >= 4) return 'Fair'; return sfi >= 100 && kp <= 2 ? 'Good' : sfi >= 80 ? 'Fair' : 'Poor'; }
    _condMid(kp, sfi, f, g) { if (kp >= 4) return 'Poor'; return sfi >= g ? 'Good' : sfi >= f ? 'Fair' : 'Poor'; }
    _condHigh(kp, sfi, f, g) { if (kp >= 4) return 'Poor'; return sfi >= g ? 'Good' : sfi >= f ? 'Fair' : 'Poor'; }
    _condVhf(kp, sfi) { if (kp >= 5) return 'Aurora'; return sfi >= 150 ? 'Good' : sfi >= 120 ? 'Fair' : 'Poor'; }

    // ── Icon resolution ──────────────────────────────────────
    _resolveIcon(shortForecast, isDaytime) {
        const fc = shortForecast.toLowerCase();
        const tod = isDaytime ? 'day' : 'night';
        if (fc.includes('thunder')) return this._icon(`wx-${tod}-thunderstorm-72`, 'wx-thunderstorm-72');
        if (fc.includes('blizzard') || fc.includes('snow') || fc.includes('flurr')) return this._icon(`wx-${tod}-snow-72`, 'wx-snow-72');
        if (fc.includes('sleet') || fc.includes('ice pellet')) return this._icon(`wx-${tod}-sleet-72`, 'wx-sleet-72');
        if (fc.includes('freez')) return this._icon('wx-freezing-rain-72');
        if (fc.includes('shower') || fc.includes('drizzle') || fc.includes('rain')) {
            if (fc.includes('slight') || fc.includes('chance') || fc.includes('scattered') || fc.includes('iso'))
                return this._icon('wx-scattered-showers-72');
            return this._icon('wx-showers-72');
        }
        if (fc.includes('fog') || fc.includes('mist')) return this._icon(`wx-${tod}-fog-72`, 'wx-fog-72');
        if (fc.includes('haze') || fc.includes('smoke') || fc.includes('dust')) return this._icon(`wx-${tod}-haze-72`, 'wx-haze-72');
        if (fc.includes('windy') || fc.includes('breezy')) return this._icon('wx-windy-72');
        if (fc.includes('overcast')) return this._icon(`wx-${tod}-overcast-72`, 'wx-overcast-72');
        if (fc.includes('mostly cloudy') || fc.includes('considerable cloud')) return this._icon(`wx-${tod}-partly-cloudy-72`);
        if (fc.includes('partly cloudy') || fc.includes('partly sunny')) return this._icon(`wx-${tod}-partly-cloudy-72`);
        if (fc.includes('mostly clear') || fc.includes('mostly sunny') ||
            fc.includes('few clouds') || fc.includes('scattered clouds')) return this._icon(`wx-${tod}-scattered-clouds-72`);
        return this._icon(`wx-${tod}-clear-72`);
    }

    _icon(...names) {
        for (let name of names) {
            let path = `${this._assetsPath}/${name}.png`;
            if (GLib.file_test(path, GLib.FileTest.EXISTS)) return path;
        }
        return `${this._assetsPath}/${names[0]}.png`;
    }

    // ── HTTP helper ──────────────────────────────────────────
    _httpGet(url, onSuccess, onError) {
        if (!url) { if (onError) onError(new Error('empty URL')); return; }
        let session = new Soup.Session();
        let message = Soup.Message.new('GET', url);
        message.request_headers.append('User-Agent', USER_AGENT);
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                let bytes = session.send_and_read_finish(result);
                onSuccess(JSON.parse(new TextDecoder().decode(bytes.get_data())));
            } catch (e) {
                log(`SimpleWx: HTTP error for ${url}: ${e}`);
                if (onError) onError(e);
            }
        });
    }

    // Flexible last-valid-entry finder for NOAA array responses
    // Tries field names in order, returns first numeric match from end of array
    _lastValidEntry(data, fieldNames) {
        if (!Array.isArray(data) || data.length === 0) return null;
        let reversed = [...data].reverse();
        for (let row of reversed) {
            if (Array.isArray(row)) {
                // Array-of-arrays format — try indices 1 and 2
                for (let idx of [1, 2]) {
                    let val = parseFloat(row[idx]);
                    if (!isNaN(val) && val >= 0) return val;
                }
            } else if (typeof row === 'object') {
                // Array-of-objects format — try field names in order
                for (let field of fieldNames) {
                    let val = parseFloat(row[field]);
                    if (!isNaN(val) && val >= 0) return val;
                }
            }
        }
        return null;
    }

    _updateMigraineIndicator() {
        let score = 0;
        let factors = [];

        // ·· Barometric pressure trend ··
        let trend = this._pressureTrend();
        let pressureDelta = this._pressureHistory.length >= 2
            ? this._pressureHistory[0].val - this._pressureHistory[this._pressureHistory.length - 1].val
            : 0;
        if (pressureDelta > MX.PRESSURE_DROP_SHARP) {
            score += MX.SCORE_PRESSURE_MILD + MX.SCORE_PRESSURE_SHARP;
            factors.push(`Pressure ↓ sharply`);
        } else if (pressureDelta > MX.PRESSURE_DROP_MILD) {
            score += MX.SCORE_PRESSURE_MILD;
            factors.push(`Pressure ↓`);
        }

        // ·· K-index ··
        if (this._currentKp >= MX.KP_THRESHOLD_SEVERE) {
            score += MX.SCORE_KP_MILD + MX.SCORE_KP_SEVERE;
            factors.push(`Kp ${this._currentKp.toFixed(1)} (severe storm)`);
        } else if (this._currentKp >= MX.KP_THRESHOLD_MILD) {
            score += MX.SCORE_KP_MILD;
            factors.push(`Kp ${this._currentKp.toFixed(1)} (active)`);
        }

        // ·· Electron flux ··
        if (this._currentElectronFlux >= MX.ELECTRON_ELEVATED) {
            score += MX.SCORE_ELECTRON;
            factors.push(`e⁻ flux elevated`);
        }

        // ·· Proton flux ··
        if (this._currentProtonFlux >= MX.PROTON_ELEVATED) {
            score += MX.SCORE_PROTON;
            factors.push(`p⁺ flux elevated`);
        }

        // ·· Terrestrial wind ··
        if (this._currentWindSpeed >= MX.WIND_HIGH) {
            score += MX.SCORE_WIND;
            factors.push(`Wind ${this._currentWindSpeed} mph`);
        }

        // ·· Temperature swing ··
        if (this._forecastTempSwing >= MX.TEMP_SWING) {
            score += MX.SCORE_TEMP_SWING;
            factors.push(`Temp swing ${this._forecastTempSwing}°`);
        }

        // ·· Map score to indicator ··
        let indicator;
        if (score <= 2) indicator = { label: 'Low', color: '#44cc44' };
        else if (score <= 5) indicator = { label: 'Moderate', color: '#cccc00' };
        else if (score <= 8) indicator = { label: 'Elevated', color: '#ff8800' };
        else indicator = { label: 'High', color: '#ff2200' };

        this._mxIndicatorLabel.set_text(indicator.label);
        this._mxIndicatorLabel.set_style(`color: ${indicator.color}; font-weight: bold;`);
        this._mxScoreLabel.set_text(`  (${score})`);
        this._mxScoreLabel.set_style(`color: ${indicator.color};`);
        this._mxFactorsLabel.set_text(factors.length > 0 ? factors.join('  ·  ') : 'No significant factors');
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
                this._fetchCurrentObservation();
                this._updateSunriseSunset();
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
