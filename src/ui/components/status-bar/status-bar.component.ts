import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { WorkspaceStateService } from '../../store/workspace-state.service';

/** Footer bar showing the active workspace name + path. */
@Component({
	selector: 'hu-status-bar',
	templateUrl: './status-bar.component.html',
	styleUrls: ['./status-bar.component.scss'],
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class StatusBarComponent {
	protected readonly workspace = inject(WorkspaceStateService);
}
