package com.nexus.controller;

import com.nexus.model.SimulationFrame;
import com.nexus.service.FrameRecorder;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * REST API for the replay system.
 *
 * The frontend fetches recorded frames once, stores them locally,
 * and drives its own playback loop — no streaming required.
 */
@RestController
@RequestMapping("/api/replay")
@CrossOrigin(origins = "*")
@RequiredArgsConstructor
public class ReplayController {

    private final FrameRecorder recorder;

    /** Buffer metadata — lets the frontend know what time range is available. */
    @GetMapping("/info")
    public ResponseEntity<Map<String, Object>> getInfo() {
        return ResponseEntity.ok(Map.of(
                "frameCount",      recorder.getSize(),
                "oldestTimestamp", recorder.oldestTimestamp(),
                "newestTimestamp", recorder.newestTimestamp()
        ));
    }

    /** Fetch all recorded frames. Frontend calls this once to load the buffer. */
    @GetMapping("/frames")
    public ResponseEntity<List<SimulationFrame>> getAllFrames() {
        return ResponseEntity.ok(recorder.queryAll());
    }

    /** Fetch frames within a time range (ms since epoch). */
    @GetMapping("/frames/range")
    public ResponseEntity<List<SimulationFrame>> getFrameRange(
            @RequestParam long from,
            @RequestParam long to) {
        return ResponseEntity.ok(recorder.query(from, to));
    }
}
