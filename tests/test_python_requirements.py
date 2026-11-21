from pathlib import Path


def test_requirements_txt_is_well_formed() -> None:
    req_path = Path(__file__).resolve().parent.parent / "requirements.txt"
    assert req_path.is_file(), "requirements.txt must exist at repository root"
    lines = [
        line.strip()
        for line in req_path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    assert len(lines) >= 4, "requirements.txt should list core Python analysis packages"
    joined = "\n".join(lines).lower()
    for pkg in ("matplotlib", "numpy", "scipy", "pillow"):
        assert pkg in joined, f"Expected package {pkg} in requirements.txt"
    assert "c:\\users" not in joined and "d:\\" not in joined
