# WebKit tester for the WhoT gui-mock suite (#170).
#
# Drop-in counterpart of the firefox-testing skill's FirefoxTester: the
# suite only consumes navigate / execute_script / find_element(s) /
# set_window_size and the raw driver (ActionChains), and everything below
# start() is plain Selenium — so a Remote session against WebKitWebDriver
# (the engine the Tauri app actually ships, #168) carries the whole suite.
#
# Unlike GeckoDriver (fetched by webdriver_manager), WebKitWebDriver is a
# system binary (/usr/bin/WebKitWebDriver, package webkitgtk-driver);
# this class spawns its OWN driver process on a free port per session, so
# a crashed run can never leak a wedged session into the next one.
#
# WebKit has no true headless mode: `headless=True` is accepted for API
# parity and only asserts that a display exists (DISPLAY/WAYLAND_DISPLAY)
# — headless boxes need Xvfb (README § Tests).

import os
import socket
import subprocess
import time

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.options import ArgOptions
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

MINIBROWSER = "/usr/libexec/webkit2gtk-4.1/MiniBrowser"


class WebKitElement(webdriver.remote.webelement.WebElement):
    """WebElement with a WORKING `.text`.

    WebKitWebDriver's getElementText is unreliable (returns '' or a
    fragment where innerText is correct — observed on the person tree:
    `.tree-name` → '' while innerText → 'Marianne Lombard'). innerText
    via the wire protocol is exact and is what Firefox's `.text`
    returns anyway, so route `.text` through it.
    """

    @property
    def text(self) -> str:
        v = self.get_attribute("innerText")
        return "" if v is None else v

    def click(self):
        """Click with an occlusion retry.

        WebKitWebDriver hit-tests the click point BEFORE dispatching
        events (geckodriver dispatches first), so an open typeahead
        dropdown sitting over the button is rejected even though a real
        click would never reach it: mousedown blurs the input, the app
        closes the list (SuggestInput.onBlur), and the click lands.
        Reproduce that sequence — blur, wait for the React re-render,
        retry — once; a still-occluded retry propagates the original
        error.
        """
        from selenium.common.exceptions import ElementClickInterceptedException

        try:
            super().click()
        except ElementClickInterceptedException:
            self._parent.execute_script(
                "document.activeElement && document.activeElement.blur();"
            )
            time.sleep(0.3)  # let React close the popup (SuggestInput.onBlur)
            super().click()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _status_ready(port: int) -> bool:
    import json
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/status", timeout=2) as r:
            return json.load(r)["value"]["ready"]
    except Exception:
        return False


class WebKitTester:
    """Same surface as FirefoxTester — a Remote session on WebKitWebDriver."""

    def __init__(self, headless=True, window_size=None):
        self.headless = headless
        self.driver = None
        self.window_size = window_size
        self._proc = None
        self._port = None

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.stop()

    # ── lifecycle ──────────────────────────────────────────────────

    def start(self):
        if self.headless and not (
            os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
        ):
            raise RuntimeError(
                "WebKitGTK needs a display — run under Xvfb "
                "(xorg-x11-server-Xvfb) or set WHOT_GUI_DRIVER=firefox"
            )
        if not os.path.isfile(MINIBROWSER):
            raise RuntimeError(f"MiniBrowser not found at {MINIBROWSER}")

        print("Starting WebKitWebDriver...")
        self._port = _free_port()
        self._proc = subprocess.Popen(
            ["WebKitWebDriver", f"--port={self._port}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        for _ in range(50):
            if _status_ready(self._port):
                break
            if self._proc.poll() is not None:
                raise RuntimeError("WebKitWebDriver exited on startup")
            time.sleep(0.1)
        else:
            self.stop()
            raise RuntimeError("WebKitWebDriver did not become ready")

        opts = ArgOptions()
        opts.set_capability("browserName", "MiniBrowser")
        opts.set_capability(
            "webkitgtk:browserOptions",
            {"binary": MINIBROWSER, "args": ["--automation"]},
        )
        try:
            self.driver = webdriver.Remote(
                command_executor=f"http://127.0.0.1:{self._port}",
                options=opts,
                web_element_cls=WebKitElement,
            )
            if self.window_size:
                self.set_window_size(*self.window_size)
            print("WebKit started successfully.")
        except Exception as e:
            self.stop()
            print(f"Failed to start WebKit: {e}")
            raise

    def stop(self):
        if self.driver:
            print("Closing WebKit...")
            try:
                self.driver.quit()
            except Exception:
                pass
            self.driver = None
        if self._proc:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except Exception:
                self._proc.kill()
            self._proc = None

    # ── navigation ─────────────────────────────────────────────────

    def navigate(self, url):
        print(f"Navigating to: {url}")
        self.driver.get(url)

    def go_back(self):
        self.driver.back()

    def go_forward(self):
        self.driver.forward()

    def refresh(self):
        self.driver.refresh()

    # ── page info ──────────────────────────────────────────────────

    def get_title(self):
        return self.driver.title

    def get_url(self):
        return self.driver.current_url

    def get_page_source(self):
        return self.driver.page_source

    # ── viewport ───────────────────────────────────────────────────

    def set_window_size(self, width, height):
        print(f"Setting window size to: {width}x{height}")
        self.driver.set_window_size(width, height)

    def get_window_size(self):
        return self.driver.get_window_size()

    # ── element queries (identical wait semantics to FirefoxTester) ─

    def find_element(self, by, value, timeout=10):
        print(f"Finding element: {by}={value}")
        return WebDriverWait(self.driver, timeout).until(
            EC.presence_of_element_located((by, value))
        )

    def find_elements(self, by, value, timeout=10):
        print(f"Finding elements: {by}={value}")
        return WebDriverWait(self.driver, timeout).until(
            EC.visibility_of_all_elements_located((by, value))
        )

    def is_element_present(self, by, value, timeout=5):
        try:
            self.find_element(by, value, timeout)
            return True
        except Exception:
            return False

    def is_element_visible(self, by, value, timeout=5):
        try:
            WebDriverWait(self.driver, timeout).until(
                EC.visibility_of_element_located((by, value))
            )
            return True
        except Exception:
            return False

    def get_element_rect(self, by, value, timeout=10):
        return self.find_element(by, value, timeout).rect

    def get_element_attribute(self, by, value, attr, timeout=10):
        return self.find_element(by, value, timeout).get_attribute(attr)

    def get_element_property(self, by, value, prop, timeout=10):
        return self.find_element(by, value, timeout).get_property(prop)

    def get_computed_style(self, by, value, prop, timeout=10):
        el = self.find_element(by, value, timeout)
        return self.execute_script(
            "return window.getComputedStyle(arguments[0]).getPropertyValue(arguments[1]);",
            el,
            prop,
        )

    def get_text(self, by, value, timeout=10):
        return self.find_element(by, value, timeout).text

    # ── element interaction ────────────────────────────────────────

    def click(self, by, value, timeout=10):
        self.find_element(by, value, timeout).click()

    def double_click(self, by, value, timeout=10):
        from selenium.webdriver.common.action_chains import ActionChains

        el = self.find_element(by, value, timeout)
        ActionChains(self.driver).double_click(el).perform()

    def right_click(self, by, value, timeout=10):
        from selenium.webdriver.common.action_chains import ActionChains

        el = self.find_element(by, value, timeout)
        ActionChains(self.driver).context_click(el).perform()

    def hover(self, by, value, timeout=10):
        from selenium.webdriver.common.action_chains import ActionChains

        el = self.find_element(by, value, timeout)
        ActionChains(self.driver).move_to_element(el).perform()

    def type_text(self, by, value, text, timeout=10):
        el = self.find_element(by, value, timeout)
        el.clear()
        el.send_keys(text)

    def append_text(self, by, value, text, timeout=10):
        self.find_element(by, value, timeout).send_keys(text)

    # ── javascript ─────────────────────────────────────────────────

    def execute_script(self, script, *args):
        return self.driver.execute_script(script, *args)

    def execute_async_script(self, script, *args):
        return self.driver.execute_async_script(script, *args)

    # ── waits ──────────────────────────────────────────────────────

    def wait_for_element(self, by, value, condition=EC.presence_of_element_located, timeout=10):
        print(f"Waiting for {by}={value}...")
        return WebDriverWait(self.driver, timeout).until(condition((by, value)))

    def wait_for_not_present(self, by, value, timeout=10):
        print(f"Waiting for {by}={value} to disappear...")
        return WebDriverWait(self.driver, timeout).until_not(
            EC.presence_of_element_located((by, value))
        )

    def wait(self, seconds):
        time.sleep(seconds)

    # ── screenshots ────────────────────────────────────────────────

    def screenshot(self, filename):
        print(f"Taking screenshot: {filename}")
        self.driver.save_screenshot(filename)

    def screenshot_element(self, by, value, filename, timeout=10):
        # WebKitWebDriver's per-element screenshot endpoint is not
        # implemented (404) — crop from the viewport instead: find the
        # element rect, screenshot, trim with PIL when available.
        from PIL import Image

        el = self.find_element(by, value, timeout)
        rect = el.rect
        vp = self.driver.get_window_size()
        tmp = filename + ".full.png"
        self.driver.save_screenshot(tmp)
        scale_x = 1  # WebKit screenshots are 1:1 CSS px here
        box = (
            int(rect["x"] * scale_x),
            int(rect["y"] * scale_x),
            int((rect["x"] + rect["width"]) * scale_x),
            int((rect["y"] + rect["height"]) * scale_x),
        )
        box = (
            max(0, box[0]),
            max(0, box[1]),
            min(vp["width"], box[2]),
            min(vp["height"], box[3]),
        )
        Image.open(tmp).crop(box).save(filename)
        os.remove(tmp)
