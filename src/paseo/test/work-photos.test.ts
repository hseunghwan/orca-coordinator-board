import { expect, test } from "vitest";
import { checkPhotoSelection, clipboardPhotos, isFileDrag, readWorkPhoto } from "../client/work-photos";
import { MAX_WORK_IMAGE_BYTES, MAX_WORK_IMAGES, MAX_WORK_IMAGES_BYTES } from "../shared/operations";

const png = {type: "image/png", name: "shot.png", size: 100};

test("selection checks count, individual bytes and combined bytes before reading a batch", () => {
  expect(checkPhotoSelection([], Array(MAX_WORK_IMAGES).fill(png))).toBeNull();
  expect(checkPhotoSelection([png], Array(MAX_WORK_IMAGES).fill(png))).toBe("count");
  expect(checkPhotoSelection([], [{...png, size: 0}])).toBe("size");
  expect(checkPhotoSelection([], [{...png, size: MAX_WORK_IMAGE_BYTES}])).toBeNull();
  expect(checkPhotoSelection([], [{...png, size: MAX_WORK_IMAGE_BYTES + 1}])).toBe("size");
  const rest = MAX_WORK_IMAGES_BYTES - 2 * MAX_WORK_IMAGE_BYTES;
  const large = {size: MAX_WORK_IMAGE_BYTES};
  expect(checkPhotoSelection([large, large], [{...png, size: rest}])).toBeNull();
  expect(checkPhotoSelection([large, large], [{...png, size: rest + 1}])).toBe("total");
});

test("JPEG files with no reported MIME work while unsupported formats reject the batch", () => {
  expect(checkPhotoSelection([], [{...png, type: "", name: "photo.JPEG"}])).toBeNull();
  expect(checkPhotoSelection([], [png, {...png, type: "image/gif"}])).toBe("format");
  expect(checkPhotoSelection([], [{...png, type: "", name: "image"}])).toBe("format");
});

test("paste extracts a file once, including WebViews that expose it only as a clipboard item", () => {
  const screenshot = new File(["shot"], "Screenshot.png", {type: "image/png"});
  const entry = {kind: "file", getAsFile: () => screenshot};
  const clipboard = (files: File[], items: unknown[]) => ({files, items} as unknown as DataTransfer);
  expect(clipboardPhotos(clipboard([screenshot], [entry]))).toEqual([screenshot]);
  expect(clipboardPhotos(clipboard([], [{kind: "string"}, entry]))).toEqual([screenshot]);
  expect(clipboardPhotos(clipboard([], [{kind: "string"}]))).toEqual([]);
});

test("file dragging recognizes protected dragover and actual dropped files while keeping normal text drops", () => {
  const shot = new File(["photo"], "shot.png", {type:"image/png"});
  const transfer = (types:string[], files:File[], items:unknown[]) => ({types, files, items} as unknown as DataTransfer);
  expect(isFileDrag(transfer(["Files"], [], []))).toBe(true);
  expect(isFileDrag(transfer([], [], [{kind:"file"}]))).toBe(true);
  expect(isFileDrag(transfer([], [shot], []))).toBe(true);
  expect(isFileDrag(transfer(["text/plain", "text/uri-list"], [], [{kind:"string"}]))).toBe(false);
});

test("an inaccessible advertised file remains an attachment attempt without admitting a partial batch", () => {
  const file = new File(["x"], "one.png", {type:"image/png"});
  const unreadable = {files:[],types:["image/png"],items:[{kind:"file",getAsFile:()=>file},{kind:"file",getAsFile:()=>null}]} as unknown as DataTransfer;
  expect(isFileDrag(unreadable)).toBe(true);
  expect(clipboardPhotos(unreadable)).toEqual([]);
  expect(clipboardPhotos({files:[],items:[{kind:"file", getAsFile:()=>{throw Error("unavailable");}}]} as unknown as DataTransfer)).toEqual([]);
});

test("rejects a native read that finishes with empty or truncated data", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
  let encoded = "";
  class Reader {
    result = "";
    onload = () => {};
    readAsDataURL() { this.result = "data:image/png;base64," + encoded; this.onload(); }
  }
  Object.defineProperty(globalThis, "FileReader", {value:Reader, configurable:true});
  try {
    const source = new File(["abcd"], "four.png", {type:"image/png"});
    await expect(readWorkPhoto(source)).rejects.toThrow("read");
    encoded = "YQ==";
    await expect(readWorkPhoto(source)).rejects.toThrow("read");
    encoded = "YWJjZA==";
    expect(await readWorkPhoto(source)).toEqual({mimeType:"image/png",data:encoded});
  } finally {
    if (original) Object.defineProperty(globalThis, "FileReader", original); else Reflect.deleteProperty(globalThis, "FileReader");
  }
});
