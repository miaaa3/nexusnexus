package com.nexus.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Data
@Configuration
@ConfigurationProperties(prefix = "nexus.simulation")
public class SimulationConfig {

    private int vehicleCount = 500;
    private long updateRateMs = 100;
    private int maxVehicles = 20000;
    private Area area = new Area();

    /**
     * Road graph data source.
     * Accepted values:
     *   "overpass"   — fetch from the Overpass API at startup
     *   "local-file" — parse a local .osm / .osm.xml file at startup (default)
     */
    private String graphSource = "local-file";

    /**
     * OSM file loaded at startup when graphSource = "local-file".
     * May be an absolute path, or a path relative to the backend working directory.
     */
    private String localFile = "data/maps/mulhouse.osm";

    /**
     * Optional local GeoJSON file for IRIS zones. When present, used in
     * preference to the IGN WFS — faster, offline, deterministic. When the
     * file is missing the loader falls back to the WFS endpoint.
     */
    private String irisLocalFile = "data/iris/iris.geojson";

    @Data
    public static class Area {
        private double latMin = 48.82;
        private double latMax = 48.90;
        private double lonMin = 2.28;
        private double lonMax = 2.42;
    }
}
