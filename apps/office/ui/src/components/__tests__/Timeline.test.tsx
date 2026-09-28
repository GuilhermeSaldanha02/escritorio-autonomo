// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import Timeline from '../Timeline';
import { OfficeDataProvider } from '../../context/OfficeDataContext';
import { fixtureOfficeDataSource } from '../../data/FixtureOfficeDataSource';
import type { OfficeDataSource } from '../../data/OfficeDataSource';

describe('Timeline', () => {
  it('inicia pelo snapshot e renderiza UNTRUSTED_EXTERNAL como texto puro', async () => {
    const snapshot = await fixtureOfficeDataSource.getSnapshot();
    const dataSource: OfficeDataSource = { getSnapshot: async () => snapshot, subscribe: () => () => undefined };

    const { container } = render(
      <OfficeDataProvider dataSource={dataSource}>
        <Timeline />
      </OfficeDataProvider>,
    );

    expect(await screen.findByText('Linha do tempo')).toBeTruthy();
    expect(screen.getByText(/Fix memory leak in stream processor/)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
