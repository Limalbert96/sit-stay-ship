import { Component } from 'react';

// Isolates a flag-gated feature. If the new code throws while rendering, only
// this card degrades; the rest of the page keeps working and the error is
// reported (to New Relic) so an alert can trigger the flag's kill switch.
// "Try again" re-renders the feature, which fails and reports again while the bug exists.
export default class FlagBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    this.props.onError?.(error);
  }

  retry = () => this.setState({ failed: false });

  render() {
    if (this.state.failed) {
      return (
        <div className="card" role="alert" style={{ borderColor: '#EF4444' }}>
          <h3 style={{ marginBottom: '0.5rem' }}>{this.props.title} is temporarily unavailable</h3>
          <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>We are on it. The rest of the site is unaffected.</p>
          <button type="button" className="btn btn-secondary" onClick={this.retry}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}
