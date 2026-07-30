import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/angular';
import { MethodBadgeComponent } from './method-badge.component';
import { rendererTestProviders } from '../../test-setup';

describe('hu-method-badge', () => {
	it('renders the method uppercased', async () => {
		const { container } = await render(MethodBadgeComponent, {
			inputs: { method: 'post' },
			providers: rendererTestProviders()
		});
		const badge = container.querySelector('.badge');
		expect(badge?.textContent?.trim()).toBe('POST');
	});

	it('maps known methods to their color token and falls back to GET for unknown ones', async () => {
		const { container, fixture } = await render(MethodBadgeComponent, {
			inputs: { method: 'DELETE' },
			providers: rendererTestProviders()
		});
		const badge = container.querySelector<HTMLElement>('.badge');
		expect(badge?.style.getPropertyValue('--badge-color')).toBe('var(--hu-method-delete)');

		fixture.componentRef.setInput('method', 'FROBNICATE');
		fixture.detectChanges();
		await fixture.whenStable();
		expect(badge?.style.getPropertyValue('--badge-color')).toBe('var(--hu-method-get)');
	});
});
