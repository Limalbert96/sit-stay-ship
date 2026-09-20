import { useEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fake LaunchDarkly SDK: `state.flags` is what useFlags() returns, `client` records calls.
const { state, client, noticeError, chatMounted } = vi.hoisted(() => ({
  state: { flags: {} },
  noticeError: vi.fn(),
  chatMounted: vi.fn(),
  client: {
    on: vi.fn(),
    off: vi.fn(),
    track: vi.fn(),
    identify: vi.fn().mockResolvedValue(undefined),
    variationDetail: vi.fn(() => ({ value: false, reason: { kind: 'FALLTHROUGH' } })),
  },
}));

vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => state.flags,
  useLDClient: () => client,
}));
vi.mock('../observability', () => ({ addPageAction: vi.fn(), noticeError, tagSession: vi.fn() }));
// Records each time the chat starts, so a test can tell a fresh chat from the same one carried over.
vi.mock('./AIChatbot', () => ({
  default: function ChatSpy({ persona }) {
    useEffect(() => chatMounted(persona.key), [persona.key]);
    return null;
  },
}));

import CGCPrepLanding from './CGCPrepLanding';

beforeEach(() => {
  state.flags = {};
  vi.clearAllMocks();
});

// Release: "a flag around a specific new feature, release by toggling on,
// roll back by toggling off".
describe('feature flag around the premium videos', () => {
  it('hides the feature when the flag is off and shows it when the flag is on', () => {
    const { rerender } = render(<CGCPrepLanding />);
    expect(screen.queryByText('Premium Video Tutorials')).not.toBeInTheDocument();

    state.flags = { premiumVideoTutorials: true };
    rerender(<CGCPrepLanding />);
    expect(screen.getByText('Premium Video Tutorials')).toBeInTheDocument();

    state.flags = { premiumVideoTutorials: false };
    rerender(<CGCPrepLanding />);
    expect(screen.queryByText('Premium Video Tutorials')).not.toBeInTheDocument();
  });
});

// Instant rollback: a "listener" so the app switches with no page reload.
describe('flag change listener', () => {
  it('subscribes to changes of the flag and announces them without a reload', () => {
    render(<CGCPrepLanding />);
    const [eventName, handler] = client.on.mock.calls[0];
    expect(eventName).toBe('change:premium-video-tutorials');

    act(() => handler(true));
    expect(screen.getByRole('status')).toHaveTextContent('changed to ON');
    act(() => handler(false));
    expect(screen.getByRole('status')).toHaveTextContent('changed to OFF');
  });

  it('unsubscribes when the page unmounts', () => {
    const { unmount } = render(<CGCPrepLanding />);
    const [eventName, handler] = client.on.mock.calls[0];
    unmount();
    expect(client.off).toHaveBeenCalledWith(eventName, handler);
  });
});

describe('context and metric', () => {
  it('re-identifies with the stable key of the chosen persona', () => {
    render(<CGCPrepLanding />);
    fireEvent.change(screen.getByLabelText('Simulate user:'), { target: { value: 'alex-vip' } });
    expect(client.identify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'user', key: 'alex-vip', tier: 'free' }));
  });

  it('starts a fresh chat when the persona changes, so nobody sees another user\'s conversation', () => {
    render(<CGCPrepLanding />);
    expect(chatMounted).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Simulate user:'), { target: { value: 'alex-vip' } });
    expect(chatMounted).toHaveBeenCalledTimes(2);
    expect(chatMounted).toHaveBeenLastCalledWith('alex-vip');
  });

  it('sends the conversion metric when Start Training is clicked', () => {
    render(<CGCPrepLanding />);
    fireEvent.click(screen.getByRole('button', { name: 'Start Training' }));
    expect(client.track).toHaveBeenCalledWith('clicked-start-training');
  });
});

// Remediation demo: a bad release that the boundary contains and reports.
describe('simulate a bad release', () => {
  it('breaks only the flagged feature, reports the error, and recovers when unticked', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    state.flags = { premiumVideoTutorials: true };
    render(<CGCPrepLanding />);
    expect(screen.getByText('Premium Video Tutorials')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Simulate a bad release'));
    expect(screen.getByRole('alert')).toHaveTextContent('temporarily unavailable');
    expect(screen.getByRole('button', { name: 'Start Training' })).toBeInTheDocument();
    expect(noticeError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ flag: 'premium-video-tutorials' }));

    fireEvent.click(screen.getByLabelText('Simulate a bad release'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Premium Video Tutorials')).toBeInTheDocument();
  });

  it('offers a kill switch button that calls the backend, only while the release is bad', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ fired: true }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<CGCPrepLanding />);
    expect(screen.queryByRole('button', { name: 'Fire kill switch' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Simulate a bad release'));
    fireEvent.click(screen.getByRole('button', { name: 'Fire kill switch' }));
    expect(await screen.findByText(/Kill switch fired/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/kill-switch', { method: 'POST' });
    vi.unstubAllGlobals();
  });

  it('explains what to do when no trigger URL is configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 501, json: async () => ({}) }));
    render(<CGCPrepLanding />);
    fireEvent.click(screen.getByLabelText('Simulate a bad release'));
    fireEvent.click(screen.getByRole('button', { name: 'Fire kill switch' }));
    expect(await screen.findByText(/Set LD_TRIGGER_URL/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
