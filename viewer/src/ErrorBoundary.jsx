import { Component } from 'react';
import { exportSettings, download, today, key } from './settings.js';

const PREFIX = 'car-compare/';

/**
 * A render crash used to take the whole page with it -- React unmounts the
 * tree and leaves a blank background, with no hint of what happened and no
 * way back except the devtools console.
 *
 * That is exactly what a settings import from a newer viewer did: the file
 * carried filter lists (`{name, rules}`), the older build only knew
 * `{name, ids}`, and reading `list.ids.length` threw on the first render --
 * including the very render that would have drawn the button to undo it.
 *
 * So the boundary offers the two things that were missing in that moment: the
 * error text, and a reset that hands the setup out as a file before clearing
 * it. Notes and lists are typed by hand and exist nowhere else, so the reset
 * downloads first and asks second.
 */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Fahrzeugvergleich ist abgestürzt:', error, info);
  }

  saveSettings() {
    download(
      `fahrzeugvergleich-einstellungen-${today()}.json`,
      JSON.stringify(exportSettings(), null, 2),
      'application/json',
    );
  }

  resetSettings() {
    if (!window.confirm('Die Einstellungen dieses Browsers werden gesichert und danach gelöscht. Fortfahren?'))
      return;
    this.saveSettings();
    for (const name of Object.keys(localStorage).filter((k) => k.startsWith(PREFIX))) {
      localStorage.removeItem(name);
    }
    window.location.reload();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <h1>Der Vergleich konnte nicht angezeigt werden.</h1>
        <p className="muted">
          Meist liegt das an gespeicherten Einstellungen, die dieser Stand des Viewers noch nicht
          kennt — etwa nach einem Import aus einer neueren Version.
        </p>
        <pre>{String(error?.message ?? error)}</pre>
        <div className="crash-actions">
          <button onClick={() => this.saveSettings()}>Einstellungen sichern</button>
          <button onClick={() => this.resetSettings()}>Sichern und zurücksetzen</button>
          <button onClick={() => window.location.reload()}>Neu laden</button>
        </div>
        <p className="muted">
          Nur die Listen zurücksetzen, Notizen behalten: <code>{key('lists')}</code> in der
          Konsole aus dem <code>localStorage</code> entfernen.
        </p>
      </div>
    );
  }
}
