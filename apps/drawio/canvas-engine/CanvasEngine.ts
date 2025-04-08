import {
  FillStyle,
  FONT_SIZE_MAP,
  FontFamily,
  FontSize,
  FontStyle,
  LOCALSTORAGE_CANVAS_KEY,
  RoughStyle,
  Shape,
  StrokeEdge,
  StrokeStyle,
  StrokeWidth,
  TextAlign,
  ToolType,
} from "@/types/canvas";
import { SelectionController } from "./SelectionController";
import { v4 as uuidv4 } from "uuid";
import {
  RoomParticipants,
  WebSocketMessage,
  WsDataType,
} from "@repo/common/types";
import {
  ARROW_HEAD_LENGTH,
  DEFAULT_BG_FILL,
  DEFAULT_STROKE_FILL,
  DEFAULT_STROKE_WIDTH,
  DIAMOND_CORNER_RADIUS_PERCENTAGE,
  ERASER_TOLERANCE,
  getDashArrayDashed,
  getDashArrayDotted,
  RECT_CORNER_RADIUS_FACTOR,
  WS_URL,
} from "@/config/constants";
import { MessageQueue } from "./MessageQueue";
import { decryptData, encryptData } from "@/utils/crypto";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error
import { RoughCanvas } from "roughjs/canvas";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error
import { Options } from "roughjs/core";
import rough from "roughjs/bin/rough";
import { getFontSize, getLineHeight } from "@/utils/textUtils";
import { generateFreeDrawPath } from "./RenderElements";

export class CanvasEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private roughCanvas: RoughCanvas;
  private roomId: string | null;
  private userId: string | null;
  private userName: string | null;
  private token: string | null;
  private canvasBgColor: string;
  private isStandalone: boolean = false;
  private onScaleChangeCallback: (scale: number) => void;
  private onParticipantsUpdate:
    | ((participants: RoomParticipants[]) => void)
    | null;
  private onConnectionChange: ((isConnected: boolean) => void) | null;
  private onShapeCountChange: ((count: number) => void) | null = null;
  public setOnShapeCountChange(callback: (count: number) => void) {
    this.onShapeCountChange = callback;
  }

  private clicked: boolean;
  public outputScale: number = 1;
  private activeTool: ToolType = "grab";
  private startX: number = 0;
  private startY: number = 0;
  private panX: number = 0;
  private panY: number = 0;
  private scale: number = 1;
  private strokeWidth: StrokeWidth = 1;
  private strokeFill: string = "rgba(255, 255, 255)";
  private bgFill: string = "rgba(18, 18, 18)";
  private strokeEdge: StrokeEdge = "round";
  private strokeStyle: StrokeStyle = "solid";
  private roughStyle: RoughStyle = 1;
  private fillStyle: FillStyle = "solid";
  private fontFamily: FontFamily = "hand-drawn";
  private fontSize: FontSize = "Medium";
  private textAlign: TextAlign = "left";

  private selectedShape: Shape | null = null;
  private existingShapes: Shape[];
  private SelectionController: SelectionController;

  private socket: WebSocket | null = null;
  private isConnected = false;
  private participants: RoomParticipants[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private flushInterval: any;
  private encryptionKey: string | null;

  private roughSeed: number = 1;

  constructor(
    canvas: HTMLCanvasElement,
    roomId: string | null,
    userId: string | null,
    userName: string | null,
    token: string | null,
    canvasBgColor: string,
    onScaleChangeCallback: (scale: number) => void,
    isStandalone: boolean = false,
    onParticipantsUpdate: ((participants: RoomParticipants[]) => void) | null,
    onConnectionChange: ((isConnected: boolean) => void) | null,
    encryptionKey: string | null
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.roughCanvas = rough.canvas(canvas);
    this.canvasBgColor = canvasBgColor;
    this.roomId = roomId;
    this.userId = userId;
    this.userName = userName;
    this.token = token;
    this.isStandalone = isStandalone;
    this.onScaleChangeCallback = onScaleChangeCallback;
    this.onParticipantsUpdate = onParticipantsUpdate;
    this.onConnectionChange = onConnectionChange;
    this.SelectionController = new SelectionController(this.ctx, canvas);

    this.encryptionKey = encryptionKey;

    this.clicked = false;
    this.existingShapes = [];

    this.canvas.width = document.body.clientWidth;
    this.canvas.height = document.body.clientHeight;

    this.init();
    this.initMouseHandler();

    this.SelectionController.setOnUpdate(() => {
      if (this.isStandalone) {
        localStorage.setItem(
          LOCALSTORAGE_CANVAS_KEY,
          JSON.stringify(this.existingShapes)
        );
      }
    });
    if (!this.isStandalone && this.token && this.roomId) {
      console.log("✅Connecting to WebSocket…");
      this.connectWebSocket();
      console.log("✅Connected to WebSocket…");
    }
  }

  private connectWebSocket() {
    const url = `${WS_URL}?token=${encodeURIComponent(this.token!)}`;
    this.socket = new WebSocket(url);

    this.socket.onopen = () => {
      this.isConnected = true;
      this.onConnectionChange?.(true);
      this.socket?.send(
        JSON.stringify({
          type: WsDataType.JOIN,
          roomId: this.roomId,
          userId: this.userId,
          userName: this.userName,
        })
      );
    };

    this.socket.onmessage = async (event) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data);

        switch (data.type) {
          case WsDataType.USER_JOINED:
            if (data.participants && Array.isArray(data.participants)) {
              this.participants = data.participants;
              this.onParticipantsUpdate?.(this.participants);
            }

            break;

          case WsDataType.USER_LEFT:
            if (data.userId) {
              this.participants = this.participants.filter(
                (u) => u.userId !== data.userId
              );
              this.onParticipantsUpdate?.(this.participants);
            }
            break;

          case WsDataType.DRAW:
          case WsDataType.UPDATE:
            if (data.userId !== this.userId && data.message) {
              const decrypted = await decryptData(
                data.message,
                this.encryptionKey!
              );
              const shape = JSON.parse(decrypted);
              this.updateShapes([shape]);
            }
            break;

          case WsDataType.ERASER:
            if (data.userId !== this.userId && data.id) {
              this.removeShape(data.id);
            }
            break;
        }
      } catch (err) {
        console.error("Error handling WS message:", err);
      }
    };

    this.socket.onclose = (e) => {
      this.isConnected = false;
      this.onConnectionChange?.(false);
      console.warn("WebSocket closed:", e);
      setTimeout(() => this.connectWebSocket(), 1000);
    };

    this.socket.onerror = (err) => {
      this.isConnected = false;
      this.onConnectionChange?.(false);
      console.error("WebSocket error:", err);
    };

    this.flushInterval = setInterval(() => {
      if (this.isConnected) {
        MessageQueue.flush((message) => {
          if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(message));
            return true;
          }
          return false;
        });
      }
    }, 5000);
  }

  public async sendMessage(content: string) {
    if (!content?.trim()) return;
    const parsed = JSON.parse(content);

    if (this.socket?.readyState === WebSocket.OPEN) {
      const base = {
        roomId: parsed.roomId,
        userId: this.userId,
        userName: this.userName,
      };

      const encryptedMessage = await encryptData(
        JSON.stringify(parsed.message),
        this.encryptionKey!
      );

      const msg = {
        ...base,
        type: parsed.type,
        id: parsed.id,
        message: encryptedMessage,
      };
      this.socket.send(JSON.stringify(msg));
    } else {
      MessageQueue.enqueue({
        type: parsed.type,
        id: parsed.id,
        message: parsed.message ? JSON.stringify(parsed.message) : null,
        roomId: this.roomId!,
        userId: this.userId!,
        userName: this.userName!,
        timestamp: new Date().toISOString(),
        participants: null,
      });
    }
  }

  async init() {
    if (this.isStandalone) {
      try {
        const storedShapes = localStorage.getItem(LOCALSTORAGE_CANVAS_KEY);
        if (storedShapes) {
          const parsedShapes = JSON.parse(storedShapes);
          this.existingShapes = [...this.existingShapes, ...parsedShapes];
        }
      } catch (e) {
        console.error("Error loading shapes from localStorage:", e);
      }
    }
    this.clearCanvas();
  }

  initMouseHandler() {
    this.canvas.addEventListener("mousedown", this.mouseDownHandler);
    this.canvas.addEventListener("mousemove", this.mouseMoveHandler);
    this.canvas.addEventListener("mouseup", this.mouseUpHandler);
    this.canvas.addEventListener("wheel", this.mouseWheelHandler, {
      passive: false,
    });
  }

  setTool(tool: ToolType) {
    this.activeTool = tool;
    if (tool !== "selection") {
      this.selectedShape = null;
      this.SelectionController.setSelectedShape(null);
      this.clearCanvas();
    }
  }

  setStrokeWidth(width: StrokeWidth) {
    this.strokeWidth = width;
    this.clearCanvas();
  }

  setStrokeFill(fill: string) {
    this.strokeFill = fill;
    this.clearCanvas();
  }

  setBgFill(fill: string) {
    this.bgFill = fill;
    this.clearCanvas();
  }

  setCanvasBgColor(color: string) {
    this.ctx.fillStyle = color;
    this.clearCanvas();
    if (this.canvasBgColor !== color) {
      this.canvasBgColor = color;
      this.clearCanvas();
    }
  }

  setStrokeEdge(edge: StrokeEdge) {
    this.strokeEdge = edge;
    this.clearCanvas();
  }

  setStrokeStyle(style: StrokeStyle) {
    this.strokeStyle = style;
    this.clearCanvas();
  }

  setRoughStyle(rough: RoughStyle) {
    this.roughStyle = rough;
    this.clearCanvas();
  }

  setFillStyle(fill: FillStyle) {
    this.fillStyle = fill;
    this.clearCanvas();
  }

  setFontFamily(fontFamily: FontFamily) {
    this.fontFamily = fontFamily;
    this.clearCanvas();
  }

  setFontSize(size: FontSize) {
    this.fontSize = size;
    this.clearCanvas();
  }

  setTextAlign(align: TextAlign) {
    this.textAlign = align;
    this.clearCanvas();
  }

  private getRoughOptions(
    strokeWidth: number,
    strokeFill: string,
    roughStyle: RoughStyle,
    bgFill?: string,
    strokeStyle?: StrokeStyle,
    fillStyle?: FillStyle,
    hachureAngle: number = 60
  ): Options {
    const options: Options = {
      stroke: strokeFill,
      strokeWidth: strokeStyle !== "solid" ? strokeWidth + 0.5 : strokeWidth,
      roughness: roughStyle,
      bowing: roughStyle === 0 ? 0 : 0.5 * roughStyle,
      fill: bgFill ?? "",
      fillStyle: fillStyle,
      hachureAngle: hachureAngle,
      hachureGap: strokeWidth * 4,
      seed: this.roughSeed,
      disableMultiStroke: true,
      disableMultiStrokeFill: true,
      fillWeight: strokeWidth,
      strokeLineDash:
        strokeStyle === "dashed"
          ? getDashArrayDashed(strokeWidth)
          : strokeStyle === "dotted"
            ? getDashArrayDotted(strokeWidth)
            : undefined,
    };

    if (strokeStyle === "dashed") {
      options.dashOffset = 5;
      options.dashArray = getDashArrayDashed(strokeWidth);
    } else if (strokeStyle === "dotted") {
      options.dashOffset = 2;
      options.dashArray = getDashArrayDotted(strokeWidth);
    }

    return options;
  }

  clearCanvas() {
    this.ctx.setTransform(this.scale, 0, 0, this.scale, this.panX, this.panY);
    this.ctx.clearRect(
      -this.panX / this.scale,
      -this.panY / this.scale,
      this.canvas.width / this.scale,
      this.canvas.height / this.scale
    );
    this.ctx.fillStyle = this.canvasBgColor;
    this.ctx.fillRect(
      -this.panX / this.scale,
      -this.panY / this.scale,
      this.canvas.width / this.scale,
      this.canvas.height / this.scale
    );

    this.existingShapes.map((shape: Shape) => {
      if (shape.type === "rectangle") {
        this.drawRect(
          shape.x,
          shape.y,
          shape.width,
          shape.height,
          shape.strokeWidth || DEFAULT_STROKE_WIDTH,
          shape.strokeFill || DEFAULT_STROKE_FILL,
          shape.bgFill || DEFAULT_BG_FILL,
          shape.rounded,
          shape.strokeStyle,
          shape.roughStyle,
          shape.fillStyle
        );
      } else if (shape.type === "ellipse") {
        this.drawEllipse(
          shape.x,
          shape.y,
          shape.radX,
          shape.radY,
          shape.strokeWidth || DEFAULT_STROKE_WIDTH,
          shape.strokeFill || DEFAULT_STROKE_FILL,
          shape.bgFill || DEFAULT_BG_FILL,
          shape.strokeStyle,
          shape.roughStyle,
          shape.fillStyle
        );
      } else if (shape.type === "diamond") {
        this.drawDiamond(
          shape.x,
          shape.y,
          shape.width,
          shape.height,
          shape.strokeWidth || DEFAULT_STROKE_WIDTH,
          shape.strokeFill || DEFAULT_STROKE_FILL,
          shape.bgFill || DEFAULT_BG_FILL,
          shape.rounded,
          shape.strokeStyle,
          shape.roughStyle,
          shape.fillStyle
        );
      } else if (shape.type === "line") {
        this.drawLine(
          shape.x,
          shape.y,
          shape.toX,
          shape.toY,
          shape.strokeWidth || DEFAULT_STROKE_WIDTH,
          shape.strokeFill || DEFAULT_STROKE_FILL,
          shape.strokeStyle,
          shape.roughStyle,
          false
        );
      } else if (shape.type === "arrow") {
        this.drawLine(
          shape.x,
          shape.y,
          shape.toX,
          shape.toY,
          shape.strokeWidth || DEFAULT_STROKE_WIDTH,
          shape.strokeFill || DEFAULT_STROKE_FILL,
          shape.strokeStyle,
          shape.roughStyle,
          true
        );
      } else if (shape.type === "free-draw") {
        this.drawFreeDraw(
          shape.points,
          shape.strokeFill,
          shape.bgFill,
          shape.strokeStyle,
          shape.fillStyle,
          shape.strokeWidth
        );
      } else if (shape.type === "text") {
        this.drawText(
          shape.x,
          shape.y,
          shape.width,
          shape.text,
          shape.strokeFill,
          shape.fontStyle,
          shape.fontFamily,
          shape.fontSize,
          shape.textAlign
        );
      }
    });

    if (
      this.SelectionController.isShapeSelected() &&
      this.activeTool === "selection"
    ) {
      const selectedShape = this.SelectionController.getSelectedShape();
      if (selectedShape) {
        const bounds = this.SelectionController.getShapeBounds(selectedShape);
        this.SelectionController.drawSelectionBox(bounds);
      }
    }
  }

  mouseUpHandler = (e: MouseEvent) => {
    if (
      this.activeTool !== "free-draw" &&
      this.activeTool !== "eraser" &&
      this.activeTool !== "line" &&
      this.activeTool !== "arrow"
    ) {
      if (this.activeTool === "selection") {
        if (
          this.SelectionController.isDraggingShape() ||
          this.SelectionController.isResizingShape()
        ) {
          const selectedShape = this.SelectionController.getSelectedShape();
          if (selectedShape) {
            const index = this.existingShapes.findIndex(
              (shape) => shape.id === selectedShape.id
            );
            if (index !== -1) {
              this.existingShapes[index] = selectedShape;
              if (this.isStandalone) {
                localStorage.setItem(
                  LOCALSTORAGE_CANVAS_KEY,
                  JSON.stringify(this.existingShapes)
                );
              } else if (this.sendMessage && this.roomId) {
                try {
                  this.sendMessage?.(
                    JSON.stringify({
                      type: WsDataType.UPDATE,
                      id: selectedShape.id,
                      message: selectedShape,
                      roomId: this.roomId,
                    })
                  );
                } catch (e) {
                  MessageQueue.enqueue({
                    type: WsDataType.UPDATE,
                    id: selectedShape.id,
                    message: JSON.stringify(selectedShape),
                    roomId: this.roomId,
                    userId: this.userId!,
                    userName: this.userName!,
                    timestamp: new Date().toISOString(),
                    participants: null,
                  });
                  console.error("Error sending shape update ws message", e);
                }
              }
            }
          }
          this.SelectionController.stopDragging();
          this.SelectionController.stopResizing();
          return;
        }
      }
    }
    this.clicked = false;

    if (this.selectedShape) {
      localStorage.setItem(
        LOCALSTORAGE_CANVAS_KEY,
        JSON.stringify(this.existingShapes)
      );
    }

    const { x, y } = this.transformPanScale(e.clientX, e.clientY);

    const width = x - this.startX;
    const height = y - this.startY;

    let shape: Shape | null = null;

    switch (this.activeTool) {
      case "rectangle":
        shape = {
          id: uuidv4(),
          type: "rectangle",
          x: this.startX,
          y: this.startY,
          width,
          height,
          strokeWidth: this.strokeWidth,
          strokeFill: this.strokeFill,
          bgFill: this.bgFill,
          rounded: this.strokeEdge,
          strokeStyle: this.strokeStyle,
          roughStyle: this.roughStyle,
          fillStyle: this.fillStyle,
        };
        break;

      case "ellipse":
        shape = {
          id: uuidv4(),
          type: "ellipse",
          x: this.startX + width / 2,
          y: this.startY + height / 2,
          radX: Math.abs(width / 2),
          radY: Math.abs(height / 2),
          strokeWidth: this.strokeWidth,
          strokeFill: this.strokeFill,
          bgFill: this.bgFill,
          strokeStyle: this.strokeStyle,
          roughStyle: this.roughStyle,
          fillStyle: this.fillStyle,
        };
        break;

      case "diamond":
        shape = {
          id: uuidv4(),
          type: "diamond",
          x: this.startX,
          y: this.startY,
          width: Math.abs(x - this.startX) * 2,
          height: Math.abs(y - this.startY) * 2,
          strokeWidth: this.strokeWidth,
          strokeFill: this.strokeFill,
          bgFill: this.bgFill,
          rounded: this.strokeEdge,
          strokeStyle: this.strokeStyle,
          roughStyle: this.roughStyle,
          fillStyle: this.fillStyle,
        };
        break;

      case "line":
        shape = {
          id: uuidv4(),
          type: "line",
          x: this.startX,
          y: this.startY,
          toX: x,
          toY: y,
          strokeWidth: this.strokeWidth,
          strokeFill: this.strokeFill,
          strokeStyle: this.strokeStyle,
          roughStyle: this.roughStyle,
        };
        break;

      case "arrow":
        shape = {
          id: uuidv4(),
          type: "arrow",
          x: this.startX,
          y: this.startY,
          toX: x,
          toY: y,
          strokeWidth: this.strokeWidth,
          strokeFill: this.strokeFill,
          strokeStyle: this.strokeStyle,
          roughStyle: this.roughStyle,
        };
        break;

      case "free-draw":
        const currentShape =
          this.existingShapes[this.existingShapes.length - 1];
        if (currentShape?.type === "free-draw") {
          shape = {
            id: uuidv4(),
            type: "free-draw",
            points: currentShape.points,
            strokeWidth: this.strokeWidth,
            strokeFill: this.strokeFill,
            bgFill: this.bgFill,
            strokeStyle: this.strokeStyle,
            fillStyle: this.fillStyle,
          };
        }
        break;

      case "grab":
        this.startX = e.clientX;
        this.startY = e.clientY;
    }

    if (!shape) {
      return;
    }

    this.existingShapes.push(shape);
    this.notifyShapeCountChange();

    if (this.isStandalone) {
      try {
        localStorage.setItem(
          LOCALSTORAGE_CANVAS_KEY,
          JSON.stringify(this.existingShapes)
        );
      } catch (e) {
        console.error("Error saving shapes to localStorage:", e);
      }
    } else if (this.sendMessage && this.roomId) {
      this.clearCanvas();

      const message = {
        type: WsDataType.DRAW,
        id: shape.id,
        message: shape,
        roomId: this.roomId,
      };

      try {
        this.sendMessage?.(JSON.stringify(message));
      } catch (e) {
        MessageQueue.enqueue({
          type: WsDataType.UPDATE,
          id: shape.id,
          message: JSON.stringify(shape),
          roomId: this.roomId,
          userId: this.userId!,
          userName: this.userName!,
          timestamp: new Date().toISOString(),
          participants: null,
        });
        console.error("Error sending shape update ws message", e);
      }
    }
    this.clearCanvas();
  };

  mouseWheelHandler = (e: WheelEvent) => {
    e.preventDefault();

    if (e.ctrlKey || e.metaKey) {
      const scaleAmount = -e.deltaY / 200;
      const newScale = this.scale * (1 + scaleAmount);

      const mouseX = e.clientX - this.canvas.offsetLeft;
      const mouseY = e.clientY - this.canvas.offsetTop;

      const canvasMouseX = (mouseX - this.panX) / this.scale;
      const canvasMouseY = (mouseY - this.panY) / this.scale;

      this.panX -= canvasMouseX * (newScale - this.scale);
      this.panY -= canvasMouseY * (newScale - this.scale);

      this.scale = newScale;

      this.onScaleChange(this.scale);
    } else {
      this.panX -= e.deltaX;
      this.panY -= e.deltaY;
    }

    this.clearCanvas();
  };

  mouseDownHandler = (e: MouseEvent) => {
    const { x, y } = this.transformPanScale(e.clientX, e.clientY);

    if (this.activeTool === "selection") {
      const selectedShape = this.SelectionController.getSelectedShape();
      if (selectedShape) {
        const bounds = this.SelectionController.getShapeBounds(selectedShape);
        const handle = this.SelectionController.getResizeHandleAtPoint(
          x,
          y,
          bounds
        );

        if (handle) {
          this.SelectionController.startResizing(x, y);
          return;
        }
      }

      for (let i = this.existingShapes.length - 1; i >= 0; i--) {
        const shape = this.existingShapes[i];

        if (this.SelectionController.isPointInShape(x, y, shape)) {
          this.selectedShape = shape;
          this.SelectionController.setSelectedShape(shape);
          this.SelectionController.startDragging(x, y);
          this.clearCanvas();
          return;
        }
      }
      this.selectedShape = null;
      this.SelectionController.setSelectedShape(null);
      this.clearCanvas();
      return;
    }

    this.clicked = true;
    this.startX = x;
    this.startY = y;

    if (this.activeTool === "free-draw") {
      this.existingShapes.push({
        id: uuidv4(),
        type: "free-draw",
        points: [{ x, y }],
        strokeWidth: this.strokeWidth,
        strokeFill: this.strokeFill,
        bgFill: this.bgFill,
        strokeStyle: this.strokeStyle,
        fillStyle: this.fillStyle,
      });
    } else if (this.activeTool == "text") {
      this.clicked = false;
      this.handleTexty(e);
    } else if (this.activeTool === "eraser") {
      this.eraser(x, y);
    } else if (this.activeTool === "grab") {
      this.startX = e.clientX;
      this.startY = e.clientY;
    }
    this.clearCanvas();
  };

  mouseMoveHandler = (e: MouseEvent) => {
    const { x, y } = this.transformPanScale(e.clientX, e.clientY);

    if (this.activeTool === "selection") {
      if (this.SelectionController.isDraggingShape()) {
        this.SelectionController.updateDragging(x, y);
        this.clearCanvas();
      } else if (this.SelectionController.isResizingShape()) {
        this.SelectionController.updateResizing(x, y);
        this.clearCanvas();
      }
      return;
    }

    if (this.clicked) {
      const width = x - this.startX;
      const height = y - this.startY;

      this.clearCanvas();

      switch (this.activeTool) {
        case "rectangle":
          this.drawRect(
            this.startX,
            this.startY,
            width,
            height,
            this.strokeWidth,
            this.strokeFill,
            this.bgFill,
            this.strokeEdge,
            this.strokeStyle,
            this.roughStyle,
            this.fillStyle
          );
          break;

        case "ellipse":
          this.drawEllipse(
            this.startX + width / 2,
            this.startY + height / 2,
            Math.abs(width / 2),
            Math.abs(height / 2),
            this.strokeWidth,
            this.strokeFill,
            this.bgFill,
            this.strokeStyle,
            this.roughStyle,
            this.fillStyle
          );
          break;

        case "diamond":
          this.drawDiamond(
            this.startX,
            this.startY,
            Math.abs(x - this.startX) * 2,
            Math.abs(y - this.startY) * 2,
            this.strokeWidth,
            this.strokeFill,
            this.bgFill,
            this.strokeEdge,
            this.strokeStyle,
            this.roughStyle,
            this.fillStyle
          );
          break;

        case "line":
          this.drawLine(
            this.startX,
            this.startY,
            x,
            y,
            this.strokeWidth,
            this.strokeFill,
            this.strokeStyle,
            this.roughStyle,
            false
          );
          break;

        case "arrow":
          this.drawLine(
            this.startX,
            this.startY,
            x,
            y,
            this.strokeWidth,
            this.strokeFill,
            this.strokeStyle,
            this.roughStyle,
            true
          );
          break;

        case "free-draw":
          const currentShape =
            this.existingShapes[this.existingShapes.length - 1];
          if (currentShape?.type === "free-draw") {
            currentShape.points.push({ x, y });
            this.drawFreeDraw(
              currentShape.points,
              this.strokeFill,
              this.bgFill,
              this.strokeStyle,
              this.fillStyle,
              this.strokeWidth
            );
          }
          break;

        case "eraser":
          this.eraser(x, y);
          break;

        case "grab":
          const { x: transformedX, y: transformedY } = this.transformPanScale(
            e.clientX,
            e.clientY
          );
          const { x: startTransformedX, y: startTransformedY } =
            this.transformPanScale(this.startX, this.startY);

          const deltaX = transformedX - startTransformedX;
          const deltaY = transformedY - startTransformedY;

          this.panX += deltaX * this.scale;
          this.panY += deltaY * this.scale;
          this.startX = e.clientX;
          this.startY = e.clientY;
          this.clearCanvas();
      }
    }
  };

  private handleTexty(e: MouseEvent) {
    const { x, y } = this.transformPanScale(e.clientX, e.clientY);

    const textarea = document.createElement("textarea");
    Object.assign(textarea.style, {
      position: "absolute",
      display: "inline-block",
      backfaceVisibility: "hidden",
      margin: "0",
      padding: "0",
      border: "0",
      outline: "0",
      resize: "none",
      background: "transparent",
      overflow: "hidden",
      overflowWrap: "break-word",
      boxSizing: "content-box",
      wordBreak: "normal",
      whiteSpace: "pre-wrap",
      transform: `translate(${x * this.scale + this.panX}px, ${y * this.scale + this.panY}px)`,
      verticalAlign: "top",
      opacity: "1",
      filter: "var(--theme-filter)",
      width: "auto",
      minHeight: "2rem",
    });
    // console.log(
    //   `this.fontSize= ${this.fontSize}, this.fontFamily= ${this.fontFamily}, this.textAlign=${this.textAlign}, this.scale=${this.scale}`
    // );
    const calFont = getFontSize(this.fontSize, this.scale);
    textarea.classList.add("drawio-texty");
    textarea.dir = "auto";
    textarea.tabIndex = 0;
    textarea.wrap = "off";
    textarea.style.color = this.strokeFill;
    const fontString = `${calFont}px/1.2 ${this.fontFamily === "normal" ? "Arial" : this.fontFamily === "hand-drawn" ? "Excalifont, Xiaolai" : "Assistant"}`;
    textarea.style.font = fontString;
    textarea.style.zIndex = "1";

    const drawioContainer = document.querySelector(
      ".drawio-textEditorContainer"
    );

    if (drawioContainer) {
      drawioContainer.appendChild(textarea);
      setTimeout(() => textarea.focus(), 0);
    } else {
      console.error("Text editor container not found");
      return;
    }

    let hasUnsavedChanges = false;

    let span: HTMLSpanElement | null = null;

    const resizeTextarea = () => {
      if (span && document.body.contains(span)) {
        document.body.removeChild(span);
      }

      span = document.createElement("span");

      Object.assign(span.style, {
        visibility: "hidden",
        position: "absolute",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        font: textarea.style.font,
        width: "auto",
        height: "auto",
      });

      span.textContent = textarea.value || " ";
      document.body.appendChild(span);

      requestAnimationFrame(() => {
        textarea.style.width = `${Math.max(span!.offsetWidth + 10, 50)}px`;
        textarea.style.height = `${Math.max(span!.offsetHeight, 20)}px`;
      });
    };

    textarea.addEventListener("input", () => {
      hasUnsavedChanges = true;
      resizeTextarea();
    });
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        hasUnsavedChanges = true;
        resizeTextarea();
      }
    });

    const save = () => {
      const text = textarea.value.trim();
      if (!text) {
        textarea.remove();
        if (span && document.body.contains(span)) {
          document.body.removeChild(span);
        }
        return;
      }
      if (!span) {
        throw new Error("Span is null");
      }
      const newShape: Shape = {
        id: uuidv4(),
        type: "text",
        x: x,
        y: y,
        width: span.offsetWidth,
        text,
        fontSize: this.fontSize,
        fontFamily: this.fontFamily,
        fontStyle: "normal",
        textAlign: this.textAlign,
        strokeFill: this.strokeFill,
      };

      this.existingShapes.push(newShape);
      this.notifyShapeCountChange();

      if (this.isStandalone) {
        localStorage.setItem(
          LOCALSTORAGE_CANVAS_KEY,
          JSON.stringify(this.existingShapes)
        );
      } else if (this.sendMessage && this.roomId) {
        this.sendMessage(
          JSON.stringify({
            type: WsDataType.DRAW,
            id: newShape.id,
            message: newShape,
            roomId: this.roomId,
          })
        );
      }

      if (drawioContainer?.contains(textarea)) {
        drawioContainer.removeChild(textarea);
        if (span && document.body.contains(span)) {
          document.body.removeChild(span);
        }
      }

      this.clearCanvas();
      hasUnsavedChanges = false;
    };

    textarea.addEventListener("input", () => {
      hasUnsavedChanges = true;
    });

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      }
    });

    const handleClickOutside = (e: MouseEvent) => {
      if (!textarea.contains(e.target as Node)) {
        save();
      }
    };

    setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 100);

    textarea.addEventListener("blur", () => {
      document.removeEventListener("mousedown", handleClickOutside);
      if (hasUnsavedChanges) {
        save();
      }
    });
  }

  isPointInShape(x: number, y: number, shape: Shape): boolean {
    const tolerance = ERASER_TOLERANCE;

    switch (shape.type) {
      case "rectangle": {
        const startX = Math.min(shape.x, shape.x + shape.width);
        const endX = Math.max(shape.x, shape.x + shape.width);
        const startY = Math.min(shape.y, shape.y + shape.height);
        const endY = Math.max(shape.y, shape.y + shape.height);

        return (
          x >= startX - tolerance &&
          x <= endX + tolerance &&
          y >= startY - tolerance &&
          y <= endY + tolerance
        );
      }
      case "ellipse": {
        const dx = x - shape.x;
        const dy = y - shape.y;
        const normalized =
          (dx * dx) / ((shape.radX + tolerance) * (shape.radX + tolerance)) +
          (dy * dy) / ((shape.radY + tolerance) * (shape.radY + tolerance));
        return normalized <= 1;
      }
      case "diamond": {
        const dx = Math.abs(x - shape.x);
        const dy = Math.abs(y - shape.y);

        return (
          dx / (shape.width / 2 + tolerance) +
            dy / (shape.height / 2 + tolerance) <=
          1
        );
      }
      case "line": {
        const lineLength = Math.hypot(shape.toX - shape.x, shape.toY - shape.y);
        const distance =
          Math.abs(
            (shape.toY - shape.y) * x -
              (shape.toX - shape.x) * y +
              shape.toX * shape.y -
              shape.toY * shape.x
          ) / lineLength;

        const withinLineBounds =
          x >= Math.min(shape.x, shape.toX) - tolerance &&
          x <= Math.max(shape.x, shape.toX) + tolerance &&
          y >= Math.min(shape.y, shape.toY) - tolerance &&
          y <= Math.max(shape.y, shape.toY) + tolerance;

        return distance <= tolerance && withinLineBounds;
      }
      case "arrow": {
        const lineLength = Math.hypot(shape.toX - shape.x, shape.toY - shape.y);
        const distance =
          Math.abs(
            (shape.toY - shape.y) * x -
              (shape.toX - shape.x) * y +
              shape.toX * shape.y -
              shape.toY * shape.x
          ) / lineLength;

        const withinLineBounds =
          x >= Math.min(shape.x, shape.toX) - tolerance &&
          x <= Math.max(shape.x, shape.toX) + tolerance &&
          y >= Math.min(shape.y, shape.toY) - tolerance &&
          y <= Math.max(shape.y, shape.toY) + tolerance;

        return distance <= tolerance && withinLineBounds;
      }
      case "free-draw": {
        return shape.points.some(
          (point) => Math.hypot(point.x - x, point.y - y) <= tolerance
        );
      }

      case "text": {
        const startX = shape.x;
        const endX = shape.x + shape.width;
        const startY = shape.y;
        const textHeight = FONT_SIZE_MAP[shape.fontSize];
        const endY = shape.y + textHeight;

        return (
          x >= startX - tolerance &&
          x <= endX + tolerance &&
          y >= startY - tolerance &&
          y <= endY + tolerance
        );
      }

      default:
        return false;
    }
  }

  transformPanScale(
    clientX: number,
    clientY: number
  ): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left - this.panX) / this.scale;
    const y = (clientY - rect.top - this.panY) / this.scale;
    return { x, y };
  }

  drawRect(
    x: number,
    y: number,
    width: number,
    height: number,
    strokeWidth: number,
    strokeFill: string,
    bgFill: string,
    rounded: StrokeEdge,
    strokeStyle: StrokeStyle,
    roughStyle: RoughStyle,
    fillStyle: FillStyle
  ) {
    const posX = width < 0 ? x + width : x;
    const posY = height < 0 ? y + height : y;
    const normalizedWidth = Math.abs(width);
    const normalizedHeight = Math.abs(height);
    if (roughStyle === 0) {
      const radius = Math.min(
        Math.abs(
          Math.max(normalizedWidth, normalizedHeight) /
            RECT_CORNER_RADIUS_FACTOR
        ),
        normalizedWidth / 2,
        normalizedHeight / 2
      );

      this.ctx.beginPath();
      this.ctx.strokeStyle = strokeFill;
      this.ctx.lineWidth = strokeWidth;
      this.ctx.fillStyle = bgFill;

      this.ctx.setLineDash(
        strokeStyle === "dashed"
          ? getDashArrayDashed(strokeWidth)
          : strokeStyle === "dotted"
            ? getDashArrayDotted(strokeWidth)
            : []
      );

      this.ctx.roundRect(
        posX,
        posY,
        normalizedWidth,
        normalizedHeight,
        rounded === "round" ? [radius] : [0]
      );

      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.stroke();
    } else {
      const options = this.getRoughOptions(
        strokeWidth,
        strokeFill,
        roughStyle,
        bgFill,
        strokeStyle,
        fillStyle
      );

      if (rounded === "round") {
        const radius = Math.min(
          Math.abs(
            Math.max(normalizedWidth, normalizedHeight) /
              RECT_CORNER_RADIUS_FACTOR
          ),
          normalizedWidth / 2,
          normalizedHeight / 2
        );
        options.curveFitting = 1;
        options.curveTightness = 1;

        this.roughCanvas.path(
          `M ${posX + radius} ${posY} 
         L ${posX + normalizedWidth - radius} ${posY} 
         Q ${posX + normalizedWidth} ${posY} ${posX + normalizedWidth} ${posY + radius} 
         L ${posX + normalizedWidth} ${posY + normalizedHeight - radius} 
         Q ${posX + normalizedWidth} ${posY + normalizedHeight} ${posX + normalizedWidth - radius} ${posY + normalizedHeight} 
         L ${posX + radius} ${posY + normalizedHeight} 
         Q ${posX} ${posY + normalizedHeight} ${posX} ${posY + normalizedHeight - radius} 
         L ${posX} ${posY + radius} 
         Q ${posX} ${posY} ${posX + radius} ${posY} 
         Z`,
          options
        );
      } else {
        this.roughCanvas.rectangle(
          posX,
          posY,
          normalizedWidth,
          normalizedHeight,
          options
        );
      }
    }
  }

  drawEllipse(
    x: number,
    y: number,
    width: number,
    height: number,
    strokeWidth: number,
    strokeFill: string,
    bgFill: string,
    strokeStyle: StrokeStyle,
    roughStyle: RoughStyle,
    fillStyle: FillStyle
  ) {
    if (roughStyle === 0) {
      this.ctx.beginPath();
      this.ctx.strokeStyle = strokeFill;
      this.ctx.lineWidth = strokeWidth;
      this.ctx.setLineDash(
        strokeStyle === "dashed"
          ? getDashArrayDashed(strokeWidth)
          : strokeStyle === "dotted"
            ? getDashArrayDotted(strokeWidth)
            : []
      );
      this.ctx.fillStyle = bgFill;
      this.ctx.ellipse(
        x,
        y,
        width < 0 ? 1 : width,
        height < 0 ? 1 : height,
        0,
        0,
        2 * Math.PI
      );
      this.ctx.fill();
      this.ctx.stroke();
    } else {
      const options = this.getRoughOptions(
        strokeWidth,
        strokeFill,
        roughStyle,
        bgFill,
        strokeStyle,
        fillStyle
      );
      this.roughCanvas.ellipse(
        x,
        y,
        width < 0 ? 2 : width * 2,
        height < 0 ? 2 : height * 2,
        options
      );
    }
  }

  drawDiamond(
    centerX: number,
    centerY: number,
    width: number,
    height: number,
    strokeWidth: number,
    strokeFill: string,
    bgFill: string,
    rounded: StrokeEdge,
    strokeStyle: StrokeStyle,
    roughStyle: RoughStyle,
    fillStyle: FillStyle
  ) {
    const halfWidth = width / 2;
    const halfHeight = height / 2;

    const normalizedWidth = Math.abs(halfWidth);
    const normalizedHeight = Math.abs(halfHeight);

    if (roughStyle === 0) {
      this.ctx.setLineDash(
        strokeStyle === "dashed"
          ? getDashArrayDashed(strokeWidth)
          : strokeStyle === "dotted"
            ? getDashArrayDotted(strokeWidth)
            : []
      );

      if (rounded === "round") {
        const cornerRadiusPercentage: number = DIAMOND_CORNER_RADIUS_PERCENTAGE;

        const sideLength = Math.min(
          Math.sqrt(
            Math.pow(normalizedWidth, 2) + Math.pow(normalizedHeight, 2)
          ),
          2 * normalizedWidth,
          2 * normalizedHeight
        );

        let radius = (sideLength * cornerRadiusPercentage) / 100;

        const maxRadius = Math.min(normalizedWidth, normalizedHeight) * 0.4;
        radius = Math.min(radius, maxRadius);

        const topPoint = { x: centerX, y: centerY - halfHeight };
        const rightPoint = { x: centerX + halfWidth, y: centerY };
        const bottomPoint = { x: centerX, y: centerY + halfHeight };
        const leftPoint = { x: centerX - halfWidth, y: centerY };

        this.ctx.save();

        this.ctx.beginPath();

        const distTopLeft = Math.sqrt(
          Math.pow(topPoint.x - leftPoint.x, 2) +
            Math.pow(topPoint.y - leftPoint.y, 2)
        );

        const startX =
          leftPoint.x + ((topPoint.x - leftPoint.x) * radius) / distTopLeft;
        const startY =
          leftPoint.y + ((topPoint.y - leftPoint.y) * radius) / distTopLeft;

        this.ctx.moveTo(startX, startY);

        this.ctx.arcTo(
          topPoint.x,
          topPoint.y,
          rightPoint.x,
          rightPoint.y,
          radius
        );

        this.ctx.arcTo(
          rightPoint.x,
          rightPoint.y,
          bottomPoint.x,
          bottomPoint.y,
          radius
        );

        this.ctx.arcTo(
          bottomPoint.x,
          bottomPoint.y,
          leftPoint.x,
          leftPoint.y,
          radius
        );

        this.ctx.arcTo(
          leftPoint.x,
          leftPoint.y,
          topPoint.x,
          topPoint.y,
          radius
        );

        this.ctx.lineTo(startX, startY);
        this.ctx.closePath();

        this.ctx.fillStyle = bgFill;
        this.ctx.strokeStyle = strokeFill;
        this.ctx.lineWidth = strokeWidth;

        this.ctx.fill();
        this.ctx.stroke();
      } else {
        this.ctx.beginPath();
        this.ctx.strokeStyle = strokeFill;
        this.ctx.lineWidth = strokeWidth;
        this.ctx.fillStyle = bgFill;

        this.ctx.moveTo(centerX, centerY - halfHeight);
        this.ctx.lineTo(centerX + halfWidth, centerY);
        this.ctx.lineTo(centerX, centerY + halfHeight);
        this.ctx.lineTo(centerX - halfWidth, centerY);
        this.ctx.closePath();
        this.ctx.fill();
        this.ctx.stroke();
      }
    } else {
      const options = this.getRoughOptions(
        strokeWidth,
        strokeFill,
        roughStyle,
        bgFill,
        strokeStyle,
        fillStyle
      );

      const diamondPoints = [
        [centerX, centerY - halfHeight],
        [centerX + halfWidth, centerY],
        [centerX, centerY + halfHeight],
        [centerX - halfWidth, centerY],
      ];

      this.roughCanvas.polygon(diamondPoints, options);
    }
  }

  drawLine(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    strokeWidth: number,
    strokeFill: string,
    strokeStyle: StrokeStyle,
    roughStyle: RoughStyle,
    arrowHead: boolean
  ) {
    if (roughStyle === 0) {
      this.ctx.beginPath();
      this.ctx.strokeStyle = strokeFill;
      this.ctx.lineWidth = strokeWidth;
      this.ctx.setLineDash(
        strokeStyle === "dashed"
          ? getDashArrayDashed(strokeWidth)
          : strokeStyle === "dotted"
            ? getDashArrayDotted(strokeWidth)
            : []
      );
      this.ctx.moveTo(fromX, fromY);
      this.ctx.lineTo(toX, toY);
      this.ctx.stroke();
    } else {
      const options = this.getRoughOptions(
        strokeWidth,
        strokeFill,
        roughStyle,
        undefined,
        strokeStyle
      );
      this.roughCanvas.line(fromX, fromY, toX, toY, options);
    }

    if (arrowHead) {
      const angleHeadAngle = Math.atan2(toY - fromY, toX - fromX);
      const length = ARROW_HEAD_LENGTH * (strokeStyle !== "solid" ? 2 : 1);

      const arrowX1 = toX - length * Math.cos(angleHeadAngle - Math.PI / 6);
      const arrowY1 = toY - length * Math.sin(angleHeadAngle - Math.PI / 6);
      const arrowX2 = toX - length * Math.cos(angleHeadAngle + Math.PI / 6);
      const arrowY2 = toY - length * Math.sin(angleHeadAngle + Math.PI / 6);

      if (roughStyle === 0) {
        this.ctx.beginPath();
        this.ctx.moveTo(toX, toY);
        this.ctx.lineTo(arrowX1, arrowY1);
        this.ctx.moveTo(toX, toY);
        this.ctx.lineTo(arrowX2, arrowY2);
        this.ctx.stroke();
      } else {
        const options = this.getRoughOptions(
          strokeWidth,
          strokeFill,
          roughStyle
        );
        this.roughCanvas.line(toX, toY, arrowX1, arrowY1, options);
        this.roughCanvas.line(toX, toY, arrowX2, arrowY2, options);
      }
    }
  }

  drawFreeDraw(
    points: { x: number; y: number }[],
    strokeFill: string,
    bgFill: string,
    strokeStyle: StrokeStyle,
    fillStyle: FillStyle,
    strokeWidth: StrokeWidth
  ) {
    if (!points.length) return;

    // const svgPathData = generateFreeDrawPath(points, strokeWidth);

    if (fillStyle === "solid") {
      const path = new Path2D(generateFreeDrawPath(points, strokeWidth));

      this.ctx.save();
      this.ctx.fillStyle = strokeFill;
      this.ctx.fill(path);

      if (strokeStyle === "dashed" || strokeStyle === "dotted") {
        this.ctx.strokeStyle = strokeFill;
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash(
          strokeStyle === "dashed"
            ? getDashArrayDashed(1)
            : getDashArrayDotted(1)
        );
        this.ctx.stroke(path);
        this.ctx.setLineDash([]);
      }

      this.ctx.restore();
    } else {
      // // For rough/sketchy style, use the existing implementation
      const pathStr = points.reduce(
        (path, point, index) =>
          path +
          (index === 0
            ? `M ${point.x} ${point.y}`
            : ` L ${point.x} ${point.y}`),
        ""
      );

      const options = this.getRoughOptions(
        strokeWidth,
        strokeFill,
        0,
        bgFill,
        "solid",
        fillStyle
      );
      this.roughCanvas.path(pathStr, options);

      // For rough/sketchy style, use the improved path with rough.js
      // const options = this.getRoughOptions(
      //   strokeWidth,
      //   strokeFill,
      //   0,
      //   bgFill,
      //   "solid",
      //   fillStyle
      // );

      // // Use the SVG path data from perfect-freehand with rough.js
      // this.roughCanvas.path(svgPathData, options);
    }
  }

  drawText(
    x: number,
    y: number,
    width: number,
    text: string,
    fillStyle: string,
    fontStyle: FontStyle,
    fontFamily: FontFamily,
    fontSize: FontSize,
    textAlign: TextAlign
  ) {
    const calFontSize = getFontSize(fontSize, this.scale);
    const lineHeight = getLineHeight(calFontSize);

    const fontString = `${fontStyle} ${calFontSize}px/1.2 ${fontFamily === "normal" ? "Arial" : fontFamily === "hand-drawn" ? "Excalifont, Xiaolai" : "Assistant"}`;
    this.ctx.font = fontString;
    this.ctx.fillStyle = fillStyle;
    this.ctx.textAlign = textAlign;

    const lines = text.split("\n");

    lines.forEach((line, index) => {
      let tx = x;
      if (textAlign === "center") {
        tx = x + width / 2;
      } else if (textAlign === "right") {
        tx = x + width;
      }
      const ty = y + (index + 1) * lineHeight;
      this.ctx.fillText(line, tx, ty);
    });
  }

  eraser(x: number, y: number) {
    const shapeIndex = this.existingShapes.findIndex((shape) =>
      this.isPointInShape(x, y, shape)
    );

    if (shapeIndex !== -1) {
      const erasedShape = this.existingShapes[shapeIndex];
      this.existingShapes.splice(shapeIndex, 1);
      this.notifyShapeCountChange();
      this.clearCanvas();

      if (this.isStandalone) {
        try {
          localStorage.setItem(
            LOCALSTORAGE_CANVAS_KEY,
            JSON.stringify(this.existingShapes)
          );
        } catch (e) {
          console.error("Error saving shapes to localStorage:", e);
        }
      } else if (this.sendMessage && this.roomId) {
        try {
          this.sendMessage?.(
            JSON.stringify({
              type: WsDataType.ERASER,
              id: erasedShape.id,
              roomId: this.roomId,
            })
          );
        } catch (e) {
          MessageQueue.enqueue({
            type: WsDataType.UPDATE,
            id: erasedShape.id,
            message: null,
            roomId: this.roomId,
            userId: this.userId!,
            userName: this.userName!,
            timestamp: new Date().toISOString(),
            participants: null,
          });
          console.error("Error sending shape update ws message", e);
        }
      }
    }
  }

  destroy() {
    this.canvas.removeEventListener("mousedown", this.mouseDownHandler);
    this.canvas.removeEventListener("mousemove", this.mouseMoveHandler);
    this.canvas.removeEventListener("mouseup", this.mouseUpHandler);
    this.canvas.removeEventListener("wheel", this.mouseWheelHandler);

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({
          type: WsDataType.LEAVE,
          roomId: this.roomId,
        })
      );
    }
    this.socket?.close();
    this.socket = null;

    if (this.flushInterval) clearInterval(this.flushInterval);
  }

  onScaleChange(scale: number) {
    this.outputScale = scale;
    if (this.onScaleChangeCallback) {
      this.onScaleChangeCallback(scale);
    }
  }

  setScale(newScale: number) {
    const rect = this.canvas.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    this.panX -= centerX * (newScale - this.scale);
    this.panY -= centerY * (newScale - this.scale);

    this.scale = newScale;
    this.onScaleChange(this.scale);
    this.clearCanvas();
  }

  clearAllShapes() {
    this.existingShapes = [];
    this.notifyShapeCountChange();
    this.clearCanvas();
    if (this.isStandalone) {
      localStorage.removeItem(LOCALSTORAGE_CANVAS_KEY);
    }
  }

  handleResize(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;

    this.clearCanvas();
  }

  public getExistingShape(id: string): Shape | undefined {
    return this.existingShapes.find((shape) => shape.id === id);
  }

  public hasShape(id: string): boolean {
    return this.existingShapes.some((shape) => shape.id === id);
  }

  public updateShape(updatedShape: Shape): void {
    const index = this.existingShapes.findIndex(
      (shape) => shape.id === updatedShape.id
    );
    if (index !== -1) {
      this.existingShapes[index] = updatedShape;
      this.clearCanvas();
    }
  }

  public updateShapes(shapes: Shape[]): void {
    shapes.forEach((shape) => {
      const index = this.existingShapes.findIndex((s) => s.id === shape.id);
      if (index === -1) {
        this.existingShapes.push(shape);
      } else {
        this.existingShapes[index] = shape;
        const selected = this.SelectionController.getSelectedShape();
        if (selected && selected.id === shape.id) {
          this.SelectionController.setSelectedShape(shape);
        }
      }
    });
    this.clearCanvas();
  }

  public removeShape(id: string): void {
    this.existingShapes = this.existingShapes.filter(
      (shape) => shape.id !== id
    );
    this.clearCanvas();
  }

  private notifyShapeCountChange() {
    this.onShapeCountChange?.(this.existingShapes.length);
  }
}
