package com.nexus.service;

import com.nexus.model.MapLoadResponse;
import com.nexus.simulation.LocalFileRoadGraphProvider;
import com.nexus.simulation.RoadGraph;
import com.nexus.simulation.SimulationEngine;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import javax.xml.stream.XMLStreamException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Locale;

@Slf4j
@Service
@RequiredArgsConstructor
public class MapImportService {

    private static final long MAX_FILE_SIZE_BYTES = 300L * 1024L * 1024L;
    private static final Path MAP_DIR = Path.of("data", "maps");

    private final SimulationEngine simulationEngine;
    private final FrameRecorder frameRecorder;

    public MapLoadResponse importMap(MultipartFile file) {
        validate(file);
        Path savedFile = save(file);
        RoadGraph graph = parse(savedFile);

        simulationEngine.replaceGraph(graph, savedFile.getFileName().toString());
        frameRecorder.clear();

        RoadGraph.Bounds bounds = graph.bounds();
        return new MapLoadResponse(
                savedFile.getFileName().toString(),
                graph.nodeCount(),
                graph.edgeCount(),
                new MapLoadResponse.Bounds(
                        bounds.minLat(), bounds.maxLat(),
                        bounds.minLon(), bounds.maxLon()
                ),
                "loaded"
        );
    }

    private void validate(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new MapImportException("Upload a non-empty .osm or .osm.xml file.");
        }
        if (file.getSize() > MAX_FILE_SIZE_BYTES) {
            throw new MapImportException("OSM file is too large. Maximum size is 250 MB.");
        }

        String name = cleanFileName(file.getOriginalFilename());
        String lower = name.toLowerCase(Locale.ROOT);
        if (!(lower.endsWith(".osm") || lower.endsWith(".osm.xml"))) {
            throw new MapImportException("Invalid map file. Only .osm and .osm.xml files are supported.");
        }
    }

    private Path save(MultipartFile file) {
        String name = cleanFileName(file.getOriginalFilename());
        try {
            Files.createDirectories(MAP_DIR);
            Path destination = MAP_DIR.resolve(name).normalize();
            if (!destination.startsWith(MAP_DIR)) {
                throw new MapImportException("Invalid map filename.");
            }
            Files.copy(file.getInputStream(), destination, StandardCopyOption.REPLACE_EXISTING);
            return destination;
        } catch (IOException e) {
            throw new MapImportException("Could not save uploaded map file.", e);
        }
    }

    private RoadGraph parse(Path savedFile) {
        try {
            RoadGraph graph = new LocalFileRoadGraphProvider().load(savedFile);
            if (graph == null || graph.isEmpty()) {
                throw new MapImportException("OSM file does not contain a valid drivable road graph.");
            }
            return graph;
        } catch (MapImportException e) {
            throw e;
        } catch (XMLStreamException e) {
            throw new MapImportException("OSM XML could not be parsed. Check that the file is valid XML.", e);
        } catch (IllegalArgumentException | IllegalStateException e) {
            throw new MapImportException(e.getMessage(), e);
        } catch (Exception e) {
            log.warn("Unexpected map import failure for {}: {}", savedFile, e.getMessage(), e);
            throw new MapImportException("Map import failed. The active simulation was not changed.", e);
        }
    }

    private static String cleanFileName(String originalFilename) {
        if (originalFilename == null || originalFilename.isBlank()) {
            return "uploaded.osm";
        }
        return Path.of(originalFilename).getFileName().toString();
    }
}
