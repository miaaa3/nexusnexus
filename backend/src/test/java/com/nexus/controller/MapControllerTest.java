package com.nexus.controller;

import com.nexus.model.MapLoadResponse;
import com.nexus.service.MapImportException;
import com.nexus.service.MapImportService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class MapControllerTest {

    private MapImportService service;
    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        service = Mockito.mock(MapImportService.class);
        mvc = MockMvcBuilders.standaloneSetup(new MapController(service)).build();
    }

    private static MockMultipartFile osm() {
        return new MockMultipartFile("file", "city.osm", "application/xml", "<osm/>".getBytes());
    }

    @Test
    void uploadReturnsTheImportSummary() throws Exception {
        when(service.importMap(any())).thenReturn(new MapLoadResponse(
                "city.osm", 10, 20, new MapLoadResponse.Bounds(46.0, 46.1, -1.2, -1.1), "ok"));

        mvc.perform(multipart("/api/maps/upload").file(osm()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.mapName").value("city.osm"))
                .andExpect(jsonPath("$.nodeCount").value(10))
                .andExpect(jsonPath("$.bounds.minLat").value(46.0));
    }

    @Test
    void importFailureBecomesA400WithTheMessage() throws Exception {
        when(service.importMap(any())).thenThrow(new MapImportException("not an OSM file"));

        mvc.perform(multipart("/api/maps/upload").file(osm()))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.status").value("error"))
                .andExpect(jsonPath("$.message").value("not an OSM file"));
    }
}
