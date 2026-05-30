import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface MapBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface MapLoadResponse {
  mapName: string;
  nodeCount: number;
  edgeCount: number;
  bounds: MapBounds;
  status: 'loaded';
}

@Injectable({ providedIn: 'root' })
export class MapApiService {
  private http = inject(HttpClient);

  uploadMap(file: File): Observable<MapLoadResponse> {
    const body = new FormData();
    body.append('file', file);
    return this.http.post<MapLoadResponse>(`${environment.backendUrl}/api/maps/upload`, body);
  }
}
