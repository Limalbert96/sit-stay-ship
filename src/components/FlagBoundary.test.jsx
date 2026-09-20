import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FlagBoundary from './FlagBoundary';
import PremiumVideos from './PremiumVideos';

describe('FlagBoundary', () => {
  it('renders the feature when it is healthy', () => {
    render(<FlagBoundary title="Videos"><PremiumVideos chaos={false} /></FlagBoundary>);
    expect(screen.getAllByRole('link', { name: 'Watch' })).toHaveLength(4);
  });

  it('degrades only the feature and reports the error when it throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    render(
      <>
        <p>rest of page</p>
        <FlagBoundary title="Videos" onError={onError}><PremiumVideos chaos /></FlagBoundary>
      </>,
    );
    expect(screen.getByText('rest of page')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Videos is temporarily unavailable');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('reports again each time the user retries while the bug persists', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    render(<FlagBoundary title="Videos" onError={onError}><PremiumVideos chaos /></FlagBoundary>);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onError).toHaveBeenCalledTimes(3);
  });
});
