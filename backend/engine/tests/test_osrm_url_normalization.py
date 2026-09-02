from utils import normalize_osrm_base_url


def test_normalize_osrm_base_url_adds_scheme_and_strips_slash():
    assert normalize_osrm_base_url("localhost:5000/") == "http://localhost:5000"
    assert normalize_osrm_base_url("https://router.project-osrm.org/") == "https://router.project-osrm.org"


def test_normalize_osrm_base_url_handles_empty_values():
    assert normalize_osrm_base_url("") == ""
    assert normalize_osrm_base_url(None) == ""

