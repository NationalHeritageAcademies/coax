import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular';
import { StatusBarComponent } from './status-bar.component';
import { WorkspaceStateService } from '../../store/workspace-state.service';
import { rendererTestProviders } from '../../test-setup';
describe('hu-status-bar', () => {
	it('shows the empty state without a workspace, then the name + path once one opens', async () => {
		const { fixture } = await render(StatusBarComponent, { providers: rendererTestProviders() });
		expect(screen.getByText('No workspace')).toBeTruthy();

		const state = TestBed.inject(WorkspaceStateService);
		state.setActiveWorkspace({ id: 'w1', name: 'My APIs', path: '/tmp/my-apis' });
		fixture.detectChanges();
		await fixture.whenStable();

		expect(screen.getByText('My APIs')).toBeTruthy();
		expect(screen.getByText('/tmp/my-apis')).toBeTruthy();
	});
});
