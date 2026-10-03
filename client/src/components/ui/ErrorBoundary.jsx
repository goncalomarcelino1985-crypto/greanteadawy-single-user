import { Component } from 'react';

/** Keeps one broken panel from blanking the whole app. */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(`[${this.props.name || 'panel'}] crashed`, error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel-error" role="alert">
        <b>{this.props.name || 'This panel'} hit an error.</b>
        <span>{String(this.state.error.message || this.state.error)}</span>
        <button className="btn tiny" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
