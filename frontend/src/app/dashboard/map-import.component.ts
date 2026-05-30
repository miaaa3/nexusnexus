import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { finalize } from 'rxjs';

import { MapApiService, MapLoadResponse } from '../core/map-api.service';
import { MapStateService } from '../core/map-state.service';

@Component({
  selector: 'app-map-import',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './map-import.component.html',
  styleUrl: './map-import.component.scss'
})
export class MapImportComponent {
  private api = inject(MapApiService);
  private mapState = inject(MapStateService);

  selectedFile: File | null = null;
  loading = false;
  error = '';
  result: MapLoadResponse | null = null;

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    this.error = '';
    this.result = null;
    this.selectedFile = file;
  }

  upload(): void {
    if (!this.selectedFile || this.loading) return;

    this.loading = true;
    this.error = '';
    this.result = null;

    this.api.uploadMap(this.selectedFile)
      .pipe(finalize(() => { this.loading = false; }))
      .subscribe({
        next: response => {
          this.result = response;
          this.mapState.clearVehicles();
          this.mapState.fitBounds(response.bounds);
        },
        error: err => {
          this.error = err?.error?.message ?? 'Map import failed.';
        }
      });
  }
}
