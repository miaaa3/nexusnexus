package com.nexus.controller;

import com.nexus.model.SimulationFrame;
import com.nexus.service.FrameRecorder;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ReplayControllerTest {

    private FrameRecorder recorder;
    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        recorder = new FrameRecorder();
        mvc = MockMvcBuilders.standaloneSetup(new ReplayController(recorder)).build();
    }

    @Test
    void infoOnEmptyBuffer() throws Exception {
        mvc.perform(get("/api/replay/info"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.frameCount").value(0))
                .andExpect(jsonPath("$.oldestTimestamp").value(-1));
    }

    @Test
    void framesAndRangeReflectTheRecorder() throws Exception {
        for (long t = 1; t <= 5; t++) recorder.record(new SimulationFrame(t, 0, List.of()));

        mvc.perform(get("/api/replay/info"))
                .andExpect(jsonPath("$.frameCount").value(5))
                .andExpect(jsonPath("$.newestTimestamp").value(5));
        mvc.perform(get("/api/replay/frames"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(5));
        mvc.perform(get("/api/replay/frames/range").param("from", "2").param("to", "3"))
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[0].timestamp").value(2));
    }

    @Test
    void rangeRequiresBothBounds() throws Exception {
        mvc.perform(get("/api/replay/frames/range").param("from", "1"))
                .andExpect(status().isBadRequest());
    }
}
