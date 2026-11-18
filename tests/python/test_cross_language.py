import json
import subprocess
from pathlib import Path
import pytest
from frame_codec import (
    PROTOCOL_VERSION,
    HEADER_SIZE_BYTES,
    FLAG_SYN,
    FLAG_ACK_ONLY,
    FLAG_MSG_END,
    FrameHeader,
    Frame,
    encode_frame,
    decode_frame,
)

ROOT_DIR = Path(__file__).parent.parent.parent
DIST_CJS = ROOT_DIR / "dist" / "index.cjs"

@pytest.fixture(scope="module", autouse=True)
def build_ts():
    """Ensure dist/index.cjs is built before cross-language tests run."""
    cmd = ["npm", "run", "build"]
    subprocess.run(cmd, cwd=ROOT_DIR, check=True, capture_output=True)

def run_node_eval(code: str) -> str:
    """Executes a Node.js snippet and returns stdout."""
    res = subprocess.run(["node", "-e", code], cwd=ROOT_DIR, check=True, capture_output=True, text=True)
    return res.stdout.strip()

def test_ts_encode_python_decode():
    """TS encodes frame -> Python decodes frame."""
    test_cases = [
        {
          "version": 1,
          "flags": FLAG_SYN | FLAG_MSG_END,
          "chid": 0,
          "ackChid": 1,
          "sequenceNumber": 12345678,
          "cumulativeAckSeq": 87654321,
          "sackMask": 0xABCD,
          "payloadHex": "0102030405060708090a",
        },
        {
          "version": 1,
          "flags": FLAG_ACK_ONLY,
          "chid": 2,
          "ackChid": 0,
          "sequenceNumber": 0xFFFFFFFF,
          "cumulativeAckSeq": 0,
          "sackMask": 0xFFFF,
          "payloadHex": "",
        },
      ]

    for tc in test_cases:
        node_script = f"""
        const {{ encodeFrame }} = require('./dist/index.cjs');
        const frame = {{
          header: {{
            version: {tc['version']},
            flags: {tc['flags']},
            chid: {tc['chid']},
            ackChid: {tc['ackChid']},
            payloadLength: {len(bytes.fromhex(tc['payloadHex']))},
            sequenceNumber: {tc['sequenceNumber']},
            cumulativeAckSeq: {tc['cumulativeAckSeq']},
            sackMask: {tc['sackMask']},
          }},
          payload: Buffer.from('{tc['payloadHex']}', 'hex')
        }};
        const encoded = encodeFrame(frame);
        console.log(Buffer.from(encoded).toString('hex'));
        """
        hex_out = run_node_eval(node_script)
        encoded_bytes = bytes.fromhex(hex_out)

        decoded = decode_frame(encoded_bytes)
        assert decoded.header.version == tc["version"]
        assert decoded.header.flags == tc["flags"]
        assert decoded.header.chid == tc["chid"]
        assert decoded.header.ack_chid == tc["ackChid"]
        assert decoded.header.sequence_number == tc["sequenceNumber"]
        assert decoded.header.cumulative_ack_seq == tc["cumulativeAckSeq"]
        assert decoded.header.sack_mask == tc["sackMask"]
        assert bytes(decoded.payload).hex() == tc["payloadHex"]

def test_python_encode_ts_decode():
    """Python encodes frame -> TS decodes frame."""
    test_cases = [
        Frame(
            header=FrameHeader(
                version=1,
                flags=FLAG_MSG_END,
                chid=0,
                ack_chid=0,
                payload_length=4,
                sequence_number=100,
                cumulative_ack_seq=99,
                sack_mask=0b0000000000000011,
            ),
            payload=b"PING",
        ),
        Frame(
            header=FrameHeader(
                version=1,
                flags=FLAG_ACK_ONLY,
                chid=1,
                ack_chid=2,
                payload_length=0,
                sequence_number=4294967295,
                cumulative_ack_seq=50,
                sack_mask=0,
            ),
            payload=b"",
        ),
    ]

    for frame in test_cases:
        encoded_bytes = encode_frame(frame)
        hex_input = encoded_bytes.hex()

        node_script = f"""
        const {{ decodeFrame }} = require('./dist/index.cjs');
        const buf = Buffer.from('{hex_input}', 'hex');
        const decoded = decodeFrame(buf);
        console.log(JSON.stringify({{
          version: decoded.header.version,
          flags: decoded.header.flags,
          chid: decoded.header.chid,
          ackChid: decoded.header.ackChid,
          payloadLength: decoded.header.payloadLength,
          sequenceNumber: decoded.header.sequenceNumber,
          cumulativeAckSeq: decoded.header.cumulativeAckSeq,
          sackMask: decoded.header.sackMask,
          payloadHex: Buffer.from(decoded.payload).toString('hex')
        }}));
        """
        res_json = json.loads(run_node_eval(node_script))
        assert res_json["version"] == frame.header.version
        assert res_json["flags"] == frame.header.flags
        assert res_json["chid"] == frame.header.chid
        assert res_json["ackChid"] == frame.header.ack_chid
        assert res_json["payloadLength"] == frame.header.payload_length
        assert res_json["sequenceNumber"] == frame.header.sequence_number
        assert res_json["cumulativeAckSeq"] == frame.header.cumulative_ack_seq
        assert res_json["sackMask"] == frame.header.sack_mask
        assert res_json["payloadHex"] == bytes(frame.payload).hex()

def test_cross_language_priority_scheduling():
    """Verify JS and Python PrioritySchedulers produce identical dequeue sequences."""
    node_script = """
    const { PriorityScheduler, TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS, FLAG_MSG_END } = require('./dist/index.cjs');
    const s = new PriorityScheduler(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS);

    // Queue 3 bulk frames on ChID 2
    s.enqueueMessage(2, new Uint8Array(206 * 3));
    // Queue C2 message on ChID 0
    s.enqueueMessage(0, new Uint8Array([1, 2, 3]));
    // Queue retransmission on ChID 2
    s.enqueueRetransmission(2, {
        header: { version: 1, flags: FLAG_MSG_END, chid: 2, ackChid: 0, payloadLength: 1, sequenceNumber: 99, cumulativeAckSeq: 0, sackMask: 0 },
        payload: new Uint8Array([99])
    });

    const sequence = [];
    let f;
    while ((f = s.dequeueNextFrame()) !== null) {
        sequence.push({ chid: f.header.chid, seq: f.header.sequenceNumber });
    }
    console.log(JSON.stringify(sequence));
    """
    js_seq = json.loads(run_node_eval(node_script))

    # Perform same sequence in Python
    from priority_scheduler import PriorityScheduler
    from config import TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS
    py_s = PriorityScheduler(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)
    py_s.enqueue_message(2, b"X" * (206 * 3))
    py_s.enqueue_message(0, b"\x01\x02\x03")
    py_s.enqueue_retransmission(2, Frame(
        header=FrameHeader(version=1, flags=FLAG_MSG_END, chid=2, ack_chid=0, payload_length=1, sequence_number=99, cumulative_ack_seq=0, sack_mask=0),
        payload=b"\x63"
    ))

    py_seq = []
    while (f := py_s.dequeue_next_frame()) is not None:
        py_seq.append({"chid": f.header.chid, "seq": f.header.sequence_number})

    assert js_seq == py_seq

def test_cross_language_arq_engine():
    """Verify TS ArqEngine and Python ArqEngine exchange fragmented messages with 100% parity."""
    # Python sends multi-frame message -> JS receives and reassembles
    from arq_engine import ArqEngine
    from config import TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS

    py_sender = ArqEngine(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)
    payload_to_send = bytes((i * 11) & 0xFF for i in range(500))
    py_sender.send_message(2, payload_to_send)

    frames_hex = []
    while (f := py_sender.dequeue_next_frame(now=0)) is not None:
        frames_hex.append(encode_frame(f).hex())

    node_script = f"""
    const {{ ArqEngine, TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS, decodeFrame }} = require('./dist/index.cjs');
    const receiver = new ArqEngine(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS);
    let receivedPayload = null;
    receiver.onMessage((chid, payload) => {{
        receivedPayload = Buffer.from(payload).toString('hex');
    }});

    const framesHex = {json.dumps(frames_hex)};
    for (const hex of framesHex) {{
        const f = decodeFrame(Buffer.from(hex, 'hex'));
        receiver.onWireFrame(f, 0);
    }}
    console.log(receivedPayload);
    """
    js_received_hex = run_node_eval(node_script)
    assert js_received_hex == payload_to_send.hex()

def test_cross_language_fec_recovery():
    """Python FecEncoder generates parity frame -> JS FecDecoder recovers missing data frame."""
    from fec_engine import FecEncoder
    from frame_codec import Frame, FrameHeader, PROTOCOL_VERSION, FLAG_MSG_END

    K = 4
    py_encoder = FecEncoder(K)

    data_frames = []
    for i in range(K):
        payload = bytes([10 + i, 20 + i, 30 + i, 40 + i])
        data_frames.append(Frame(
            header=FrameHeader(version=1, flags=FLAG_MSG_END, chid=2, ack_chid=0, payload_length=4, sequence_number=i, cumulative_ack_seq=0, sack_mask=0),
            payload=payload,
        ))

    parity_frame = None
    for f in data_frames:
        p = py_encoder.add_data_frame(f)
        if p:
            parity_frame = p

    assert parity_frame is not None

    # Simulate dropping Frame 2. Send Frame 0, 1, 3 and Parity Frame to JS
    node_script = f"""
    const {{ FecDecoder, decodeFrame }} = require('./dist/index.cjs');
    const decoder = new FecDecoder({K});

    const df0 = decodeFrame(Buffer.from('{encode_frame(data_frames[0]).hex()}', 'hex'));
    const df1 = decodeFrame(Buffer.from('{encode_frame(data_frames[1]).hex()}', 'hex'));
    const df3 = decodeFrame(Buffer.from('{encode_frame(data_frames[3]).hex()}', 'hex'));
    const pf = decodeFrame(Buffer.from('{encode_frame(parity_frame).hex()}', 'hex'));

    decoder.addDataFrame(df0);
    decoder.addDataFrame(df1);
    decoder.addDataFrame(df3);

    const recovered = decoder.processParityFrame(pf);
    console.log(JSON.stringify({{
        recoveredSeq: recovered ? recovered.header.sequenceNumber : null,
        recoveredPayloadHex: recovered ? Buffer.from(recovered.payload).toString('hex') : null
    }}));
    """
    res = json.loads(run_node_eval(node_script))
    assert res["recoveredSeq"] == 2
    assert res["recoveredPayloadHex"] == bytes(data_frames[2].payload).hex()



