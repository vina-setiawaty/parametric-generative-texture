let gcodeCheck = ["G0", "G1", "G2", "G3", "G4", "G5", "G10", "G11", "G17", "G18", "G19", "G20", "G21", "G26", "G27", "G28", "G29", "G30", "G31", "G32", "G33", "G34", "G35", "G38.2", "G38.3", "G38.4", "G38.5", "G42", "G53", "G54", "G55", "G56", "G57", "G58", "G59", "G60", "G61", "G76", "G80", "G90", "G91", "G92",
  "M0", "M1", "M3", "M4", "M5", "M17", "M18", "M20", "M21", "M22", "M23", "M24", "M25", "M26", "M27", "M28", "M29", "M30", "M31", "M32", "M33", "M34", "M35", "M36", "M37", "M38", "M39", "M40", "M41", "M42", "M43", "M48", "M73", "M75", "M76", "M77", "M78", "M80", "M81", "M82", "M83", "M84", "M85", "M92", "M100", "M104", "M105", "M106", "M107", "M108", "M109", "M110", "M111", "M112", "M113", "M114", "M115", "M117", "M118", "M119", "M120", "M121", "M122", "M125", "M126", "M127", "M128", "M129", "M140", "M141", "M142", "M143", "M144", "M145", "M149", "M150", "M155", "M163", "M164", "M165", "M166", "M190", "M200", "M201", "M203", "M204", "M205", "M206", "M207", "M208", "M209", "M211", "M217", "M218", "M220", "M221", "M226", "M240", "M250", "M260", "M261", "M280", "M281", "M282", "M283", "M290", "M300", "M301", "M302", "M303", "M304", "M305", "M306", "M350", "M351", "M355", "M360", "M361", "M362", "M363", "M364", "M365", "M380", "M381", "M400", "M401", "M402", "M403", "M404", "M405", "M406", "M407", "M408", "M420", "M421", "M422", "M423", "M428", "M430", "M486", "M500", "M501", "M502", "M503", "M504", "M505", "M524", "M540", "M569", "M575", "M600", "M603", "M605", "M665", "M666", "M667", "M668", "M669", "M672", "M673", "M701", "M702", "M703", "M710", "M851", "M852", "M853", "M860", "M861", "M862", "M900", "M906", "M907", "M908", "M909", "M910", "M911", "M912", "M913", "M914", "M915", "M916", "M917", "M918", "M919", "M920", "M921", "M922", "M923", "M924", "M925", "M997", "M999",
  "T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9"];

let initX = 0;
let initY = 0;
let initZ = 0;

let nozzleTemp = 0;
let bedTemp = 0;

let keyInterval;
let keyIntervalRunning = false;

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  fab = createFab();

  loadActions();
  initActionEditor();
  initLlmEditor();
  initGcodeLlmEditor();

  loadLocalData();

  const dataInputs = document.querySelectorAll("input");
  dataInputs.forEach(i => {
    i.addEventListener("change", () => {
      storeLocalData();
    });
  });

  document.querySelector("#start-btn").addEventListener("click", () => {
    getInitPosition();
    getInitTemps();
    fab.commands = [
      "G90",
      "M83",
      "G28",
      `G0 X${initX} Y${initY} Z${initZ} F1500`,
    ];
    fab.print();
    pushMessage("printing started", "green");
  });

  document.querySelector("#stop-btn").addEventListener("click", () => {
    fab.commands = [];
    fab.stopPrint();
    pushMessage("printing stopped", "orange");
  });

  document.querySelector("#heat-btn").addEventListener("click", () => {
    if (fab.isPrinting) {
      getInitTemps();
      fab.commands = [
        `M104 S${nozzleTemp}`,
        `M140 S${bedTemp}`,
      ];
      fab.print();
      pushMessage("heating nozzle/bed", "magenta");
    } else {
      pushMessage("initialize printer first", "red");
    }
  });

  document.querySelector("#cool-btn").addEventListener("click", () => {
    if (fab.isPrinting) {
      getInitTemps();
      fab.commands = [
        `M104 S0`,
        `M140 S0`,
      ];
      fab.print();
      pushMessage("cooling nozzle/bed", "blue");
    } else {
      pushMessage("initialize printer first", "red");
    }
  });

  document.querySelector("#cold-extrusion").addEventListener("change", () => {
    if (fab.isPrinting) {
      if (document.querySelector("#cold-extrusion").checked) {
        fab.commands = [
          `M302 P1`,
        ];
        fab.print();
        pushMessage("cold extrusion enabled", "blue");
      } else {
        fab.commands = [
          `M302 P0`,
        ];
        fab.print();
      }
    } else {
      pushMessage("initialize printer first", "red");
      document.querySelector("#cold-extrusion").checked = false;
    }
  });

  document.querySelector("#fan-on").addEventListener("change", () => {
    if (fab.isPrinting) {
      if (document.querySelector("#fan-on").checked) {
        let fanSpeed = document.querySelector("#fan-speed").value;
        fanSpeed = fanSpeed > 255 ? 255 : fanSpeed < 0 ? 0 : Math.floor(fanSpeed);
        console.log(`fan speed: ${fanSpeed}`);
        fab.commands = [
          `M106 S${document.querySelector("#fan-speed").value}`,
        ];
        fab.print();
        pushMessage("fan on", "blue");
      } else {
        console.log(`fan off`);
        fab.commands = [
          `M106 S0`,
        ];
        fab.print();
        pushMessage("fan off", "blue");
      }
    } else {
      pushMessage("initialize printer first", "red");
      document.querySelector("#fan-on").checked = false;
    }
  });

  document.querySelector("#run-gcode-btn").addEventListener("click", () => {
    if (fab.isPrinting) {
      let gcode = document.querySelector("#raw-gcode-textarea").value.split("\n");
      gcode = gcode.map(g => (checkGcode(g))).filter(g => g !== "");
      fab.commands = gcode;
      fab.print();
      pushMessage("running raw gcode", "blue");
    } else {
      pushMessage("initialize printer first", "red");
    }
  });

  document.querySelector("#save-gcode-btn").addEventListener("click", () => {
    const gcode = document.querySelector("#raw-gcode-textarea").value;
    const blob = new Blob([gcode], { type: "text/plain" });

    const filenameInput = document.querySelector("#gcode-filename-input");
    let filename = filenameInput ? filenameInput.value.trim() : "";
    if (!filename) filename = "output.gcode";
    else if (!filename.includes(".")) filename += ".gcode";

    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;

    document.body.appendChild(link);
    link.click();

    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  });

  setupMotionControl();

  document.addEventListener("keyup", (e) => {
    if (keyIntervalRunning) {
      clearInterval(keyInterval);
      keyIntervalRunning = false;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (document.querySelector("#motion-keyboard-control").checked) {
      if (keyIntervalRunning) {
        pushMessage("keyboard control is busy", "red", true);
      } else {
        const speed = document.querySelector("#motion-feedrate").value;
        const travel = document.querySelector("#motion-step-size").value;
        const dt = travel / (speed / 60) * 1000 * 1.05;
        if (e.key === "a") {
          pushMessage("moving x down", "blue");
          document.querySelector("#motion-x-down-btn").click();
          keyInterval = setInterval(() => {
            document.querySelector("#motion-x-down-btn").click();
          }, dt);
        }
        if (e.key === "d") {
          pushMessage("moving x up", "blue");
          document.querySelector("#motion-x-up-btn").click();
          keyInterval = setInterval(() => {
            document.querySelector("#motion-x-up-btn").click();
          }, dt);
        }
        if (e.key === "s") {
          pushMessage("moving y down", "blue");
          document.querySelector("#motion-y-down-btn").click();
          keyInterval = setInterval(() => {
            document.querySelector("#motion-y-down-btn").click();
          }, dt);
        }
        if (e.key === "w") {
          pushMessage("moving y up", "blue");
          document.querySelector("#motion-y-up-btn").click();
          keyInterval = setInterval(() => {
            document.querySelector("#motion-y-up-btn").click();
          }, dt);
        }
        if (e.key === "z") {
          pushMessage("moving z down", "blue");
          document.querySelector("#motion-z-down-btn").click();
          keyInterval = setInterval(() => {
            document.querySelector("#motion-z-down-btn").click();
          }, dt);
        }
        if (e.key === "q") {
          pushMessage("moving z up", "blue");
          document.querySelector("#motion-z-up-btn").click();
          keyInterval = setInterval(() => {
            document.querySelector("#motion-z-up-btn").click();
          }, dt);
        }
        if (e.key === "r") {
          pushMessage("moving e down", "blue");
          document.querySelector("#motion-e-down-btn").click();
          keyInterval = setInterval(() => {
            document.querySelector("#motion-e-down-btn").click();
          }, dt);
        }
        if (e.key === "e") {
          pushMessage("moving e up", "blue");
          document.querySelector("#motion-e-up-btn").click();
          keyInterval = setInterval(() => {
            document.querySelector("#motion-e-up-btn").click();
          }, dt);
        }
        keyIntervalRunning = true;
      }
    }
  });

  frameRate(10);

  syncRawGcodeHeight();
}

function draw() {
  if (activeAction !== "") {
    if (loopingAction) {
      const activeElement = document.querySelector(`#action-${activeAction}-loop`);
      if (activeElement) {
        activeElement.classList.add("active");
      }
    } else {
      const activeElement = document.querySelector(`#action-${activeAction}-loop`);
      if (activeElement) {
        activeElement.classList.remove("active");
      }
    }
  }
  if (fab.isPrinting) {
    console.log(fab.commands);
    document.querySelector("#start-btn").classList.add("active");
    if (fab.commands.length === 0) {
      if (activeAction !== "") {
        if (loopingAction) {
          if (Date.now() - loopTimestamp > loopInterval) {
            loopTimestamp = Date.now();
            loopInterval = document.querySelector(`#action-${activeAction}-interval`).value;
            const activeElement = document.querySelector(`#action-${activeAction}-run`);
            activeElement.click();
          }
        } else {
          const activeElement = document.querySelector(`#action-${activeAction}-run`);
          if (activeElement) {
            activeElement.classList.remove("active");
          }
          activeAction = "";
        }
      }
      pushMessage("awaiting gcode", "#999", true);
    } else {
      if (activeAction !== "") {
        const activeElement = document.querySelector(`#action-${activeAction}-run`);
        if (activeElement) {
          activeElement.classList.add("active");
        }
      }
    }
  } else {
    document.querySelector("#start-btn").classList.remove("active");
    getInitPosition();
  }
}

function setupMotionControl() {
  const motionBtns = [
    document.querySelector("#motion-x-up-btn"),
    document.querySelector("#motion-x-down-btn"),
    document.querySelector("#motion-y-up-btn"),
    document.querySelector("#motion-y-down-btn"),
    document.querySelector("#motion-z-up-btn"),
    document.querySelector("#motion-z-down-btn"),
    document.querySelector("#motion-e-up-btn"),
    document.querySelector("#motion-e-down-btn"),
  ];
  motionBtns.forEach(m => {
    m.addEventListener("click", () => {
      const stepSize = document.querySelector("#motion-step-size").value;
      const feedrate = document.querySelector("#motion-feedrate").value;
      if (!fab.isPrinting) {
        pushMessage("initialize printer first", "red");
        return;
      }
      if (fab.commands.length > 0) {
        pushMessage("wait for gcode stream completion", "red");
        return;
      }
      const id = m.id.split("-");
      fab.commands.push(
        `G91`,
        `G1 F${feedrate}`,
        `G1 ${id[1].toUpperCase()}${id[2] === "up" ? stepSize : -stepSize}`,
        `G90`,
      );
      fab.print();
      if (!keyIntervalRunning) {
        pushMessage(`moved ${id[1]} ${id[2]} ${stepSize}`, "blue");
      }
    });
  });

  document.querySelector("#motion-home-btn").addEventListener("click", () => {
    getInitPosition();
    if (!fab.isPrinting) {
      pushMessage("initialize printer first", "red");
      return;
    }
    if (fab.commands.length > 0) {
      pushMessage("wait for gcode stream completion", "red");
      return;
    }
    fab.commands.push(
      `G90`,
      `G0 X${initX} Y${initY} Z${initZ}`,
    );
    fab.print();
    pushMessage(`moved to initial position`, "blue");
  });

  document.querySelector("#motion-keyboard-control").addEventListener("change", () => {
    if (document.querySelector("#motion-keyboard-control").checked) {
      document.querySelector("#motion-keyboard-control-instructions").style.display = "block";
    } else {
      document.querySelector("#motion-keyboard-control-instructions").style.display = "none";
    }
    syncRawGcodeHeight();
  });
}

function getInitPosition() {
  initX = document.querySelector("#start-x").value;
  initY = document.querySelector("#start-y").value;
  initZ = document.querySelector("#start-z").value;
}

function getInitTemps() {
  nozzleTemp = document.querySelector("#nozzle-temp").value;
  bedTemp = document.querySelector("#bed-temp").value;
}

function storeLocalData() {
  let data = {};
  const dataInputs = document.querySelectorAll("input");
  dataInputs.forEach(i => {
    if (i.id) {
      data[i.id] = i.value;
    }
  });
  localStorage.setItem("localData", JSON.stringify(data));
}

function loadLocalData() {
  const dataString = localStorage.getItem("localData");
  if (dataString) {
    const data = JSON.parse(dataString);
    for (const key in data) {
      const ele = document.querySelector(`#${key}`);
      if (ele) {
        ele.value = data[key];
      }
    }
    pushMessage("data loaded from local storage", "black");
  } else {
    pushMessage("no local data", "black");
  }
}

let previousMessage = "";
function pushMessage(msg, color, check = false) {
  const now = new Date();
  const hours = now.getHours() + "";
  const minutes = now.getMinutes() + "";
  const seconds = now.getSeconds() + "";

  if (msg === previousMessage && check) {
    document.querySelector("#message-container li").innerHTML = `[${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}:${seconds.padStart(2, "0")}] ${msg}`;
  } else {
    const li = document.createElement("li");
    li.textContent = `[${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}:${seconds.padStart(2, "0")}] ${msg}`;
    li.style.color = color;
    document.querySelector("#message-container").prepend(li);
    previousMessage = msg;
  }
}

function clearMsg() {
  document.querySelector("#message-container").innerHTML = "";
}

function syncRawGcodeHeight() {
  const rawGcodeContainer = document.querySelector("#raw-gcode-container");
  const siblingFrames = ["#messages", "#main-controller", "#motion-controller"]
    .map(sel => document.querySelector(sel))
    .filter(Boolean);
  if (!rawGcodeContainer || siblingFrames.length === 0) return;

  rawGcodeContainer.style.height = "auto";
  const targetHeight = Math.max(...siblingFrames.map(el => el.offsetHeight));
  rawGcodeContainer.style.height = `${targetHeight}px`;
}

function windowResized() {
  syncRawGcodeHeight();
}

// Returns "" for comment-only, blank and invalid lines -- callers must filter
// those out, since Marlin never answers "ok" to an empty line and the
// ok-driven stream in p5.fab.sewing.js would stall waiting for it.
function checkGcode(_gcode) {
  let _g = _gcode.split(";")[0].trim();
  if (_g === "") return "";
  if (gcodeCheck.includes(_g.split(" ")[0])) {
    return _g;
  } else {
    pushMessage(`invalid gcode: "${_gcode}"`, "red");
    return "";
  }
}