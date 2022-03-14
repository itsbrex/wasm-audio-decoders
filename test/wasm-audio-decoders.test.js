import fs from "fs/promises";
import path from "path";
import { gunzip } from "zlib";
import CodecParser from "codec-parser";

import {
  getInterleaved,
  getWaveFileHeader,
  testDecoder_decode,
  testDecoder_decodeFrames,
} from "./utilities";

import { MPEGDecoder, MPEGDecoderWebWorker } from "mpg123-decoder";
import { OpusDecoder, OpusDecoderWebWorker } from "opus-decoder";
import { OggOpusDecoder, OggOpusDecoderWebWorker } from "ogg-opus-decoder";

const EXPECTED_PATH = new URL("expected", import.meta.url).pathname;
const ACTUAL_PATH = new URL("actual", import.meta.url).pathname;
const TEST_DATA_PATH = new URL("data", import.meta.url).pathname;

const getTestPaths = (fileName, outputFileName, isWorker = false) => ({
  fileName,
  inputPath: path.join(TEST_DATA_PATH, fileName),
  actualPath: path.join(
    ACTUAL_PATH,
    (outputFileName || fileName) + (isWorker ? ".worker" : "") + ".wav"
  ),
  expectedPath: path.join(EXPECTED_PATH, (outputFileName || fileName) + ".wav"),
});

const test_decode = async (decoder, testName, fileName, outputFileName) => {
  try {
    const isWorker = decoder.constructor.name.match(/WebWorker/);
    const paths = getTestPaths(fileName, outputFileName, isWorker);

    const result = await decoder.ready.then(() =>
      testDecoder_decode(decoder, testName, paths.inputPath, paths.actualPath)
    );

    return { paths, result };
  } finally {
    decoder.free();
  }
};

const test_decode_multipleFiles = async (DecoderClass, testParams) => {
  const pathsArray = testParams.map(({ fileName }) => getTestPaths(fileName));

  const inputFiles = await Promise.all(
    pathsArray.map(({ inputPath }) => fs.readFile(inputPath))
  );

  const decoder = new DecoderClass();

  const decodedFiles = [];

  await decoder.ready;

  for (const file of inputFiles) {
    decoder.decode(file).then((result) => decodedFiles.push(result));
    decoder.reset();
  }

  await decoder.free();

  let idx = 0;

  return Promise.all(
    decodedFiles.map(async ({ samplesDecoded, sampleRate, channelData }) => {
      const paths = pathsArray[idx++];

      const actual = Buffer.concat([
        getWaveFileHeader({
          bitDepth: 16,
          sampleRate,
          length:
            samplesDecoded * Int16Array.BYTES_PER_ELEMENT * channelData.length,
          channels: channelData.length,
        }),
        getInterleaved(channelData, samplesDecoded),
      ]);

      await fs.writeFile(paths.actualPath, actual);

      return {
        paths,
        result: { samplesDecoded, sampleRate },
      };
    })
  );
};

const test_decodeFrames = async (
  decoder,
  testName,
  fileName,
  frames,
  framesLength
) => {
  const isWorker = decoder.constructor.name.match(/WebWorker/);
  const paths = getTestPaths(fileName, null, isWorker);

  const result = await decoder.ready.then(() =>
    testDecoder_decodeFrames(
      decoder,
      testName,
      frames,
      framesLength,
      paths.actualPath
    )
  );

  decoder.free();

  return { paths, result };
};

const decompressExpectedFiles = async () => {
  const files = await fs.readdir(EXPECTED_PATH);
  const decompressPromises = [];

  const compressed = new Set();
  const decompressed = new Set();

  for (const file of files) {
    if (file.match(/.*gz$/)) compressed.add(file);
    else if (file.match(/.*wav$/)) decompressed.add(file);
  }

  for (const file of compressed) {
    //if (!decompressed.has(file))
    decompressPromises.push(
      new Promise((res, rej) => {
        return fs.readFile(path.join(EXPECTED_PATH, file)).then((data) => {
          gunzip(data, async (err, uncompressed) => {
            if (err) {
              rej(err);
            } else {
              fs.writeFile(
                path.join(EXPECTED_PATH, file.slice(0, -3)),
                uncompressed
              ).then(() => {
                res();
              });
            }
          });
        });
      }).catch((e) => {
        console.warn("failed to decompress", file);
        throw e;
      })
    );
  }

  await Promise.all(decompressPromises).catch((e) => {
    console.error(e);
    throw new Error(
      "Failed to decompress one or more expected test files. Check that the test files are valid gzip."
    );
  });
};

describe("wasm-audio-decoders", () => {
  beforeAll(async () => {
    await decompressExpectedFiles();
  });

  describe("mpg123-decoder", () => {
    it("should decode mpeg", async () => {
      const { paths, result } = await test_decode(
        new MPEGDecoder(),
        "should decode mpeg",
        "mpeg.cbr.mp3"
      );

      const [actual, expected] = await Promise.all([
        fs.readFile(paths.actualPath),
        fs.readFile(paths.expectedPath),
      ]);

      expect(result.samplesDecoded).toEqual(3499776);
      expect(result.sampleRate).toEqual(44100);
      expect(actual.length).toEqual(expected.length);
      expect(Buffer.compare(actual, expected)).toEqual(0);
    });

    it("should decode mpeg in a web worker", async () => {
      const { paths, result } = await test_decode(
        new MPEGDecoderWebWorker(),
        "should decode mpeg in a web worker",
        "mpeg.cbr.mp3"
      );

      const [actual, expected] = await Promise.all([
        fs.readFile(paths.actualPath),
        fs.readFile(paths.expectedPath),
      ]);

      expect(result.samplesDecoded).toEqual(3499776);
      expect(result.sampleRate).toEqual(44100);
      expect(actual.length).toEqual(expected.length);
      expect(Buffer.compare(actual, expected)).toEqual(0);
    });

    //it("should decode a large mpeg", async () => {
    //  const decoder = new MPEGDecoder();
    //  await decoder.ready;
    //
    //  const fileName = "waug-edm-fest-spr-2015.mp3";
    //  const paths = getTestPaths(fileName);
    //
    //  const { sampleRate, samplesDecoded } = await testDecoder_decode(
    //    decoder,
    //    fileName,
    //    paths.inputPath,
    //    paths.actualPath
    //  );
    //
    //  decoder.free()
    //
    //  expect(samplesDecoded).toEqual(751564800);
    //  expect(sampleRate).toEqual(44100);
    //}, 100000);

    describe("frame decoding", () => {
      let fileName, frames, framesLength;

      beforeAll(async () => {
        fileName = "mpeg.cbr.mp3";

        const parser = new CodecParser("audio/mpeg");
        const inputData = await fs.readFile(getTestPaths(fileName).inputPath);

        frames = parser.parseAll(inputData).map((frame) => frame.data);
        framesLength = frames.reduce((acc, data) => acc + data.length, 0);
      });

      it("should decode mpeg frames", async () => {
        const { paths, result } = await test_decodeFrames(
          new MPEGDecoder(),
          "should decode mpeg frames in a web worker",
          "frames.mpeg.cbr.mp3",
          frames,
          framesLength
        );

        const [actual, expected] = await Promise.all([
          fs.readFile(paths.actualPath),
          fs.readFile(paths.expectedPath),
        ]);

        expect(result.samplesDecoded).toEqual(3498624);
        expect(result.sampleRate).toEqual(44100);
        expect(actual.length).toEqual(expected.length);
        expect(Buffer.compare(actual, expected)).toEqual(0);
      });

      it("should decode mpeg frames in a web worker", async () => {
        const { paths, result } = await test_decodeFrames(
          new MPEGDecoderWebWorker(),
          "should decode mpeg frames in a web worker",
          "frames.mpeg.cbr.mp3",
          frames,
          framesLength
        );

        const [actual, expected] = await Promise.all([
          fs.readFile(paths.actualPath),
          fs.readFile(paths.expectedPath),
        ]);

        expect(result.samplesDecoded).toEqual(3498624);
        expect(result.sampleRate).toEqual(44100);
        expect(actual.length).toEqual(expected.length);
        expect(Buffer.compare(actual, expected)).toEqual(0);
      });
    });

    describe("decoding in sequence", () => {
      it("should decode each file one at a time when decoding from the same instance", async () => {
        const results = await test_decode_multipleFiles(MPEGDecoderWebWorker, [
          {
            testName: "should decode sequential.1.mp3 in sequence",
            fileName: "sequential.1.mp3",
          },
          {
            testName: "should decode sequential.2.mp3 in sequence",
            fileName: "sequential.2.mp3",
          },
          {
            testName: "should decode sequential.3.mp3 in sequence",
            fileName: "sequential.3.mp3",
          },
          {
            testName: "should decode sequential.4.mp3 in sequence",
            fileName: "sequential.4.mp3",
          },
        ]);

        const [
          actual1,
          expected1,
          actual2,
          expected2,
          actual3,
          expected3,
          actual4,
          expected4,
        ] = await Promise.all([
          fs.readFile(results[0].paths.actualPath),
          fs.readFile(results[0].paths.expectedPath),
          fs.readFile(results[1].paths.actualPath),
          fs.readFile(results[1].paths.expectedPath),
          fs.readFile(results[2].paths.actualPath),
          fs.readFile(results[2].paths.expectedPath),
          fs.readFile(results[3].paths.actualPath),
          fs.readFile(results[3].paths.expectedPath),
        ]);

        expect(results[0].result.sampleRate).toEqual(44100);
        expect(results[0].result.samplesDecoded).toEqual(21888);
        expect(results[1].result.sampleRate).toEqual(44100);
        expect(results[1].result.samplesDecoded).toEqual(21888);
        expect(results[2].result.sampleRate).toEqual(44100);
        expect(results[2].result.samplesDecoded).toEqual(21888);
        expect(results[3].result.sampleRate).toEqual(44100);
        expect(results[3].result.samplesDecoded).toEqual(21888);

        expect(actual1.length).toEqual(expected1.length);
        expect(actual2.length).toEqual(expected2.length);
        expect(actual3.length).toEqual(expected3.length);
        expect(actual4.length).toEqual(expected4.length);
        expect(Buffer.compare(actual1, expected1)).toEqual(0);
        expect(Buffer.compare(actual2, expected2)).toEqual(0);
        expect(Buffer.compare(actual3, expected3)).toEqual(0);
        expect(Buffer.compare(actual4, expected4)).toEqual(0);
      });
    });

    describe("decoding in parallel", () => {
      it("should decode each file in it's own thread", async () => {
        const [
          { paths: paths1, result: result1 },
          { paths: paths2, result: result2 },
          { paths: paths3, result: result3 },
          { paths: paths4, result: result4 },
        ] = await Promise.all([
          test_decode(
            new MPEGDecoderWebWorker(),
            "should decode parallel.1.mp3 in it's own thread",
            "parallel.1.mp3"
          ),
          test_decode(
            new MPEGDecoderWebWorker(),
            "should decode parallel.2.mp3 in it's own thread",
            "parallel.2.mp3"
          ),
          test_decode(
            new MPEGDecoderWebWorker(),
            "should decode parallel.3.mp3 in it's own thread",
            "parallel.3.mp3"
          ),
          test_decode(
            new MPEGDecoderWebWorker(),
            "should decode parallel.4.mp3 in it's own thread",
            "parallel.4.mp3"
          ),
        ]);

        const [
          actual1,
          expected1,
          actual2,
          expected2,
          actual3,
          expected3,
          actual4,
          expected4,
        ] = await Promise.all([
          fs.readFile(paths1.actualPath),
          fs.readFile(paths1.expectedPath),
          fs.readFile(paths2.actualPath),
          fs.readFile(paths2.expectedPath),
          fs.readFile(paths3.actualPath),
          fs.readFile(paths3.expectedPath),
          fs.readFile(paths4.actualPath),
          fs.readFile(paths4.expectedPath),
        ]);

        expect(result1.sampleRate).toEqual(44100);
        expect(result1.samplesDecoded).toEqual(21888);
        expect(result2.sampleRate).toEqual(44100);
        expect(result2.samplesDecoded).toEqual(21888);
        expect(result3.sampleRate).toEqual(44100);
        expect(result3.samplesDecoded).toEqual(21888);
        expect(result4.sampleRate).toEqual(44100);
        expect(result4.samplesDecoded).toEqual(21888);

        expect(actual1.length).toEqual(expected1.length);
        expect(actual2.length).toEqual(expected2.length);
        expect(actual3.length).toEqual(expected3.length);
        expect(actual4.length).toEqual(expected4.length);
        expect(Buffer.compare(actual1, expected1)).toEqual(0);
        expect(Buffer.compare(actual2, expected2)).toEqual(0);
        expect(Buffer.compare(actual3, expected3)).toEqual(0);
        expect(Buffer.compare(actual4, expected4)).toEqual(0);
      });
    });
  });

  describe("opus-decoder", () => {
    const opusStereoTestFile = "ogg.opus";
    const opusSurroundTestFile = "ogg.opus.surround";
    const opus32TestFile = "ogg.opus.32.ogg";
    const opus64TestFile = "ogg.opus.64.ogg";
    const opus255TestFile = "ogg.opus.255.ogg";

    let opusStereoFrames,
      opusStereoHeader,
      opusStereoSampleCount,
      opusStereoFramesLength,
      opusSurroundFrames,
      opusSurroundHeader,
      opusSurroundSampleCount,
      opusSurroundFramesLength,
      opus32Frames,
      opus32Header,
      opus32SampleCount,
      opus32FramesLength,
      opus64Frames,
      opus64Header,
      opus64SampleCount,
      opus64FramesLength,
      opus255Frames,
      opus255Header,
      opus255SampleCount,
      opus255FramesLength;

    const getFrames = (codecFrames) => {
      let length = 0,
        header,
        frames,
        absoluteGranulePosition;

      frames = codecFrames
        .flatMap((frame) => {
          absoluteGranulePosition = frame.absoluteGranulePosition;
          return frame.codecFrames;
        })
        .map((codecFrame) => {
          length += codecFrame.data.length;
          header = codecFrame.header;
          return codecFrame.data;
        });

      return [frames, header, length, Number(absoluteGranulePosition)];
    };

    beforeAll(async () => {
      const parser = new CodecParser("application/ogg");

      [
        opusStereoFrames,
        opusStereoHeader,
        opusStereoFramesLength,
        opusStereoSampleCount,
      ] = getFrames(
        parser.parseAll(
          await fs.readFile(getTestPaths(opusStereoTestFile).inputPath)
        )
      );

      [
        opusSurroundFrames,
        opusSurroundHeader,
        opusSurroundFramesLength,
        opusSurroundSampleCount,
      ] = getFrames(
        parser.parseAll(
          await fs.readFile(getTestPaths(opusSurroundTestFile).inputPath)
        )
      );

      [opus32Frames, opus32Header, opus32FramesLength, opus32SampleCount] =
        getFrames(
          parser.parseAll(
            await fs.readFile(getTestPaths(opus32TestFile).inputPath)
          )
        );

      [opus64Frames, opus64Header, opus64FramesLength, opus64SampleCount] =
        getFrames(
          parser.parseAll(
            await fs.readFile(getTestPaths(opus64TestFile).inputPath)
          )
        );

      [opus255Frames, opus255Header, opus255FramesLength, opus255SampleCount] =
        getFrames(
          parser.parseAll(
            await fs.readFile(getTestPaths(opus255TestFile).inputPath)
          )
        );
    });

    it("should decode opus frames", async () => {
      const { preSkip } = opusStereoHeader;

      const { paths, result } = await test_decodeFrames(
        new OpusDecoder({
          preSkip,
        }),
        "should decode opus frames",
        "frames." + opusStereoTestFile,
        opusStereoFrames,
        opusStereoFramesLength
      );

      const [actual, expected] = await Promise.all([
        fs.readFile(paths.actualPath),
        fs.readFile(paths.expectedPath),
      ]);

      expect(result.samplesDecoded).toEqual(3807048); //3807154, 204
      expect(result.sampleRate).toEqual(48000);
      expect(Buffer.compare(actual, expected)).toEqual(0);
    });

    it("should decode opus frames in a web worker", async () => {
      const { preSkip } = opusStereoHeader;
      const { paths, result } = await test_decodeFrames(
        new OpusDecoderWebWorker({
          preSkip,
        }),
        "should decode opus frames in a web worker",
        "frames." + opusStereoTestFile,
        opusStereoFrames,
        opusStereoFramesLength
      );

      const [actual, expected] = await Promise.all([
        fs.readFile(paths.actualPath),
        fs.readFile(paths.expectedPath),
      ]);

      expect(result.samplesDecoded).toEqual(3807048); //3807154
      expect(result.sampleRate).toEqual(48000);
      expect(Buffer.compare(actual, expected)).toEqual(0);
    });

    describe("5.1 Channels", () => {
      it("should decode 5.1 channel opus frames", async () => {
        const {
          channels,
          channelMappingTable,
          coupledStreamCount,
          streamCount,
          preSkip,
        } = opusSurroundHeader;

        const { paths, result } = await test_decodeFrames(
          new OpusDecoder({
            channels,
            channelMappingTable,
            coupledStreamCount,
            streamCount,
            preSkip,
          }),
          "should decode 5.1 channel opus frames",
          "frames." + opusSurroundTestFile,
          opusSurroundFrames,
          opusSurroundFramesLength
        );

        const [actual, expected] = await Promise.all([
          fs.readFile(paths.actualPath),
          fs.readFile(paths.expectedPath),
        ]);

        expect(result.samplesDecoded).toEqual(1042248); //1042489
        expect(result.sampleRate).toEqual(48000);
        expect(Buffer.compare(actual, expected)).toEqual(0);
      });

      it("should decode 5.1 channel opus frames in a web worker", async () => {
        const {
          channels,
          channelMappingTable,
          coupledStreamCount,
          streamCount,
          preSkip,
        } = opusSurroundHeader;
        const { paths, result } = await test_decodeFrames(
          new OpusDecoderWebWorker({
            channels,
            channelMappingTable,
            coupledStreamCount,
            streamCount,
            preSkip,
          }),
          "should decode 5.1 channel opus frames in a web worker",
          "frames." + opusSurroundTestFile,
          opusSurroundFrames,
          opusSurroundFramesLength
        );

        const [actual, expected] = await Promise.all([
          fs.readFile(paths.actualPath),
          fs.readFile(paths.expectedPath),
        ]);

        expect(result.samplesDecoded).toEqual(1042248); //1042489
        expect(result.sampleRate).toEqual(48000);
        expect(Buffer.compare(actual, expected)).toEqual(0);
      });
    });

    describe("32 Channels", () => {
      it("should decode 32 channel opus frames", async () => {
        const {
          channels,
          channelMappingTable,
          coupledStreamCount,
          streamCount,
          preSkip,
        } = opus32Header;
        const { paths, result } = await test_decodeFrames(
          new OpusDecoder({
            channels,
            channelMappingTable,
            coupledStreamCount,
            streamCount,
            preSkip,
          }),
          "should decode 32 channel opus frames",
          opus32TestFile,
          opus32Frames,
          opus32FramesLength
        );

        const [actual, expected] = await Promise.all([
          fs.readFile(paths.actualPath),
          fs.readFile(paths.expectedPath),
        ]);

        expect(result.samplesDecoded).toEqual(287688); //287063
        expect(result.sampleRate).toEqual(48000);
        expect(Buffer.compare(actual, expected)).toEqual(0);
      });

      it("should decode 32 channel opus frames in a web worker", async () => {
        const {
          channels,
          channelMappingTable,
          coupledStreamCount,
          streamCount,
          preSkip,
        } = opus32Header;
        const { paths, result } = await test_decodeFrames(
          new OpusDecoderWebWorker({
            channels,
            channelMappingTable,
            coupledStreamCount,
            streamCount,
            preSkip,
          }),
          "should decode 32 channel opus frames in a web worker",
          opus32TestFile,
          opus32Frames,
          opus32FramesLength
        );

        const [actual, expected] = await Promise.all([
          fs.readFile(paths.actualPath),
          fs.readFile(paths.expectedPath),
        ]);

        expect(result.samplesDecoded).toEqual(287688); //287063
        expect(result.sampleRate).toEqual(48000);
        expect(Buffer.compare(actual, expected)).toEqual(0);
      });
    });

    describe("64 Channels", () => {
      it("should decode 64 channel opus frames", async () => {
        const {
          channels,
          channelMappingTable,
          coupledStreamCount,
          streamCount,
          preSkip,
        } = opus64Header;
        const { paths, result } = await test_decodeFrames(
          new OpusDecoder({
            channels,
            channelMappingTable,
            coupledStreamCount,
            streamCount,
            preSkip,
          }),
          "should decode 64 channel opus frames",
          opus64TestFile,
          opus64Frames,
          opus64FramesLength
        );

        const [actual, expected] = await Promise.all([
          fs.readFile(paths.actualPath),
          fs.readFile(paths.expectedPath),
        ]);

        expect(result.samplesDecoded).toEqual(287688); //287063
        expect(result.sampleRate).toEqual(48000);
        expect(Buffer.compare(actual, expected)).toEqual(0);
      });

      it("should decode 64 channel opus frames in a web worker", async () => {
        const {
          channels,
          channelMappingTable,
          coupledStreamCount,
          streamCount,
          preSkip,
        } = opus64Header;
        const { paths, result } = await test_decodeFrames(
          new OpusDecoderWebWorker({
            channels,
            channelMappingTable,
            coupledStreamCount,
            streamCount,
            preSkip,
          }),
          "should decode 64 channel opus frames in a web worker",
          opus64TestFile,
          opus64Frames,
          opus64FramesLength
        );

        const [actual, expected] = await Promise.all([
          fs.readFile(paths.actualPath),
          fs.readFile(paths.expectedPath),
        ]);

        expect(result.samplesDecoded).toEqual(287688); //287063
        expect(result.sampleRate).toEqual(48000);
        expect(Buffer.compare(actual, expected)).toEqual(0);
      });
    });

    describe("255 Channels", () => {
      it("should decode 255 channel opus frames", async () => {
        const {
          channels,
          channelMappingTable,
          coupledStreamCount,
          streamCount,
          preSkip,
        } = opus255Header;
        const { paths, result } = await test_decodeFrames(
          new OpusDecoder({
            channels,
            channelMappingTable,
            coupledStreamCount,
            streamCount,
            preSkip,
          }),
          "should decode 255 channel opus frames",
          opus255TestFile,
          opus255Frames,
          opus255FramesLength
        );

        const [actual, expected] = await Promise.all([
          fs.readFile(paths.actualPath),
          fs.readFile(paths.expectedPath),
        ]);

        expect(result.samplesDecoded).toEqual(287688); //287063
        expect(result.sampleRate).toEqual(48000);
        expect(Buffer.compare(actual, expected)).toEqual(0);
      });

      it("should decode 255 channel opus frames in a web worker", async () => {
        const {
          channels,
          channelMappingTable,
          coupledStreamCount,
          streamCount,
          preSkip,
        } = opus255Header;
        const { paths, result } = await test_decodeFrames(
          new OpusDecoderWebWorker({
            channels,
            channelMappingTable,
            coupledStreamCount,
            streamCount,
            preSkip,
          }),
          "should decode 255 channel opus frames in a web worker",
          opus255TestFile,
          opus255Frames,
          opus255FramesLength
        );

        const [actual, expected] = await Promise.all([
          fs.readFile(paths.actualPath),
          fs.readFile(paths.expectedPath),
        ]);

        expect(result.samplesDecoded).toEqual(287688); //287063
        expect(result.sampleRate).toEqual(48000);
        expect(Buffer.compare(actual, expected)).toEqual(0);
      });
    });
  });

  describe("ogg-opus-decoder", () => {
    it("should decode ogg opus", async () => {
      const { paths, result } = await test_decode(
        new OggOpusDecoder(),
        "should decode ogg opus",
        "ogg.opus"
      );

      const [actual, expected] = await Promise.all([
        fs.readFile(paths.actualPath),
        fs.readFile(paths.expectedPath),
      ]);

      expect(result.samplesDecoded).toEqual(3806842);
      expect(result.sampleRate).toEqual(48000);
      expect(actual.length).toEqual(expected.length);
      expect(Buffer.compare(actual, expected)).toEqual(0);
    });

    it("should decode multi channel ogg opus", async () => {
      const { paths, result } = await test_decode(
        new OggOpusDecoder(),
        "should decode multi channel ogg opus",
        "ogg.opus.surround"
      );

      const [actual, expected] = await Promise.all([
        fs.readFile(paths.actualPath),
        fs.readFile(paths.expectedPath),
      ]);

      expect(result.channelsDecoded).toEqual(6);
      expect(result.samplesDecoded).toEqual(1042177);
      expect(result.sampleRate).toEqual(48000);
      expect(actual.length).toEqual(expected.length);
      expect(Buffer.compare(actual, expected)).toEqual(0);
    });

    it("should decode multi channel ogg opus as stereo when force stereo is enabled", async () => {
      const decoder = new OggOpusDecoder({
        forceStereo: true,
      });

      const { paths, result } = await test_decode(
        decoder,
        "should decode multi channel ogg opus",
        "ogg.opus.surround",
        "ogg.opus.surround.downmix"
      );

      const [actual, expected] = await Promise.all([
        fs.readFile(paths.actualPath),
        fs.readFile(paths.expectedPath),
      ]);

      expect(result.channelsDecoded).toEqual(2);
      expect(result.samplesDecoded).toEqual(1042177);
      expect(result.sampleRate).toEqual(48000);
      expect(actual.length).toEqual(expected.length);
      expect(Buffer.compare(actual, expected)).toEqual(0);
    });

    it("should decode ogg opus in a web worker", async () => {
      const { paths, result } = await test_decode(
        new OggOpusDecoderWebWorker(),
        "should decode ogg opus in a web worker",
        "ogg.opus"
      );

      const [actual, expected] = await Promise.all([
        fs.readFile(paths.actualPath),
        fs.readFile(paths.expectedPath),
      ]);

      expect(result.samplesDecoded).toEqual(3806842);
      expect(result.sampleRate).toEqual(48000);
      expect(actual.length).toEqual(expected.length);
      expect(Buffer.compare(actual, expected)).toEqual(0);
    });

    it("should decode multi channel ogg opus in a web worker", async () => {
      const { paths, result } = await test_decode(
        new OggOpusDecoderWebWorker(),
        "should decode multi channel ogg opus in a web worker",
        "ogg.opus.surround"
      );

      const [actual, expected] = await Promise.all([
        fs.readFile(paths.actualPath),
        fs.readFile(paths.expectedPath),
      ]);

      expect(result.channelsDecoded).toEqual(6);
      expect(result.samplesDecoded).toEqual(1042177);
      expect(result.sampleRate).toEqual(48000);
      expect(actual.length).toEqual(expected.length);
      expect(Buffer.compare(actual, expected)).toEqual(0);
    });

    it("should decode multi channel ogg opus as stereo when force stereo is enabled in a web worker", async () => {
      const decoder = new OggOpusDecoderWebWorker({
        forceStereo: true,
      });

      const { paths, result } = await test_decode(
        decoder,
        "should decode multi channel ogg opus as stereo when force stereo is enabled in a web worker",
        "ogg.opus.surround",
        "ogg.opus.surround.downmix"
      );

      const [actual, expected] = await Promise.all([
        fs.readFile(paths.actualPath),
        fs.readFile(paths.expectedPath),
      ]);

      expect(result.channelsDecoded).toEqual(2);
      expect(result.samplesDecoded).toEqual(1042177);
      expect(result.sampleRate).toEqual(48000);
      expect(actual.length).toEqual(expected.length);
      expect(Buffer.compare(actual, expected)).toEqual(0);
    });

    it("should throw when attempting to decode a file with channel mapping 255", async () => {
      try {
        const { paths, result } = await test_decode(
          new OggOpusDecoder(),
          "should decode ogg opus",
          "ogg.opus.32.ogg"
        );

        const [actual, expected] = await Promise.all([
          fs.readFile(paths.actualPath),
          fs.readFile(paths.expectedPath),
        ]);

        expect(result.samplesDecoded).toEqual(286751);
        expect(result.sampleRate).toEqual(48000);
        expect(actual.length).toEqual(expected.length);
        expect(Buffer.compare(actual, expected)).toEqual(0);
      } catch (e) {
        expect(e.message).toEqual(
          "libopusfile -130 OP_EIMPL: The stream used a feature that is not implemented, such as an unsupported channel family."
        );
      }
    });
  });
});
