"""Unit tests for DaftariResponse parsing."""

from __future__ import annotations

from dataclasses import dataclass

from langchain_daftari.response import DaftariResponse


@dataclass
class _FakeTextContent:
    text: str
    type: str = "text"


@dataclass
class _FakeResult:
    content: list
    isError: bool = False


def test_from_mcp_result_concatenates_text_blocks():
    result = _FakeResult(content=[_FakeTextContent("hello"), _FakeTextContent("world")])
    response = DaftariResponse.from_mcp_result(result)
    assert response.text == "hello\nworld"
    assert response.is_error is False


def test_from_mcp_result_parses_json_data():
    result = _FakeResult(content=[_FakeTextContent('{"a": 1, "b": [2,3]}')])
    response = DaftariResponse.from_mcp_result(result)
    assert response.data == {"a": 1, "b": [2, 3]}


def test_from_mcp_result_falls_back_to_raw_text_when_not_json():
    result = _FakeResult(content=[_FakeTextContent("plain text reply")])
    response = DaftariResponse.from_mcp_result(result)
    assert response.data == "plain text reply"


def test_from_mcp_result_empty_content_yields_none_data():
    result = _FakeResult(content=[])
    response = DaftariResponse.from_mcp_result(result)
    assert response.text == ""
    assert response.data is None
    assert response.is_error is False


def test_from_mcp_result_error_flag_propagates():
    result = _FakeResult(content=[_FakeTextContent("boom")], isError=True)
    response = DaftariResponse.from_mcp_result(result)
    assert response.is_error is True
    assert response.text == "boom"


def test_from_mcp_result_keeps_raw():
    result = _FakeResult(content=[_FakeTextContent("x")])
    response = DaftariResponse.from_mcp_result(result)
    assert response.raw is result


def test_from_mcp_result_skips_non_text_blocks():
    class _Img:
        type = "image"
        data = "ignored"

    result = _FakeResult(content=[_FakeTextContent("keep"), _Img()])
    response = DaftariResponse.from_mcp_result(result)
    assert response.text == "keep"
