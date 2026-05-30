package com.nexus.controller;

import com.nexus.model.MapLoadResponse;
import com.nexus.service.MapImportException;
import com.nexus.service.MapImportService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.util.Map;

@RestController
@RequestMapping("/api/maps")
@CrossOrigin(origins = "*")
@RequiredArgsConstructor
public class MapController {

    private final MapImportService mapImportService;

    @PostMapping("/upload")
    public ResponseEntity<MapLoadResponse> upload(@RequestParam("file") MultipartFile file) {
        return ResponseEntity.ok(mapImportService.importMap(file));
    }

    @ExceptionHandler(MapImportException.class)
    public ResponseEntity<Map<String, String>> handleImportError(MapImportException e) {
        return ResponseEntity.badRequest().body(Map.of(
                "status", "error",
                "message", e.getMessage()
        ));
    }
}
