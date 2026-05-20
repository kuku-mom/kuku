import { onMount, onCleanup } from "solid-js";

interface KukuLogoProps {
  size?: number;
  class?: string;
}

// Eye center positions for KukuLogo
const KUKU_LEFT_EYE = { cx: 387.748, cy: 518.358 };
const KUKU_RIGHT_EYE = { cx: 514.216, cy: 481.748 };
const KUKU_EYE_RADIUS = 89.1895;
const KUKU_PUPIL_RADIUS = 29.3009;
const KUKU_MAX_PUPIL_OFFSET = KUKU_EYE_RADIUS - KUKU_PUPIL_RADIUS - 30;
// Pupil resting offset (slightly left of center)
const KUKU_PUPIL_REST_OFFSET = { x: -8, y: 0 };

export function KukuLogo(props: KukuLogoProps) {
  let svgRef: SVGSVGElement | undefined;
  let leftPupilRef: SVGCircleElement | undefined;
  let rightPupilRef: SVGCircleElement | undefined;
  let raf = 0;

  onMount(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!svgRef || !leftPupilRef || !rightPupilRef) return;
      if (raf) cancelAnimationFrame(raf);

      raf = requestAnimationFrame(() => {
        const rect = svgRef.getBoundingClientRect();
        const svgCenterX = rect.left + rect.width / 2;
        const svgCenterY = rect.top + rect.height / 2;

        const dx = e.clientX - svgCenterX;
        const dy = e.clientY - svgCenterY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance === 0) return;

        const scale = Math.min(1, distance / 200);
        const offsetX = (dx / distance) * KUKU_MAX_PUPIL_OFFSET * scale;
        const offsetY = (dy / distance) * KUKU_MAX_PUPIL_OFFSET * scale;

        leftPupilRef.setAttribute(
          "cx",
          String(KUKU_LEFT_EYE.cx + KUKU_PUPIL_REST_OFFSET.x + offsetX),
        );
        leftPupilRef.setAttribute(
          "cy",
          String(KUKU_LEFT_EYE.cy + KUKU_PUPIL_REST_OFFSET.y + offsetY),
        );
        rightPupilRef.setAttribute(
          "cx",
          String(KUKU_RIGHT_EYE.cx + KUKU_PUPIL_REST_OFFSET.x + offsetX),
        );
        rightPupilRef.setAttribute(
          "cy",
          String(KUKU_RIGHT_EYE.cy + KUKU_PUPIL_REST_OFFSET.y + offsetY),
        );
      });
    };

    window.addEventListener("mousemove", handleMouseMove);

    onCleanup(() => {
      window.removeEventListener("mousemove", handleMouseMove);
      if (raf) cancelAnimationFrame(raf);
    });
  });

  return (
    <svg
      ref={svgRef}
      aria-hidden="true"
      width={props.size ?? 80}
      height={props.size ?? 80}
      viewBox="0 0 1080 1080"
      fill="none"
      class={props.class}
    >
      <path
        d="M333.576 222.2C385.698 205.772 447.214 199.17 504.387 200.083C617.942 201.896 709.576 235.088 780.505 312.152C851.705 389.512 879.765 495.181 861.642 586.03C852.998 629.359 829.166 659.25 797.244 686.305C781.139 699.955 763.26 712.646 744.288 726.036C725.488 739.305 705.662 753.225 686.582 768.866C667.775 784.283 651.287 798.96 636.313 811.975C621.206 825.105 607.642 836.542 594.057 846.164C567.364 865.069 540.772 876.844 503.87 878.707C427.274 882.574 344.927 848.107 305.022 792.119C287.093 766.964 288.843 744.86 294.901 712.949C300.98 680.932 311.195 640.444 302.235 586.507C297.704 559.226 287.334 531.685 275.578 505.091C269.678 491.743 263.331 478.423 257.089 465.381C250.815 452.272 244.66 439.469 238.979 426.847C227.557 401.473 218.556 377.906 214.835 356.225C211.154 334.779 212.804 316.166 221.612 299.786C240.616 264.448 281.05 238.756 333.576 222.2Z"
        fill="var(--color-kuku-mark-body)"
        stroke="var(--color-kuku-mark-stroke)"
        stroke-width="30"
      />
      <circle
        cx={KUKU_LEFT_EYE.cx}
        cy={KUKU_LEFT_EYE.cy}
        r={KUKU_EYE_RADIUS}
        fill="var(--color-kuku-mark-eye)"
        stroke="var(--color-kuku-mark-pupil)"
        stroke-width="24.1053"
      />
      <circle
        cx={KUKU_RIGHT_EYE.cx}
        cy={KUKU_RIGHT_EYE.cy}
        r={KUKU_EYE_RADIUS}
        fill="var(--color-kuku-mark-eye)"
        stroke="var(--color-kuku-mark-pupil)"
        stroke-width="24.1053"
      />
      <circle
        ref={leftPupilRef}
        cx={KUKU_LEFT_EYE.cx + KUKU_PUPIL_REST_OFFSET.x}
        cy={KUKU_LEFT_EYE.cy + KUKU_PUPIL_REST_OFFSET.y}
        r={KUKU_PUPIL_RADIUS}
        fill="var(--color-kuku-mark-pupil)"
      />
      <circle
        ref={rightPupilRef}
        cx={KUKU_RIGHT_EYE.cx + KUKU_PUPIL_REST_OFFSET.x}
        cy={KUKU_RIGHT_EYE.cy + KUKU_PUPIL_REST_OFFSET.y}
        r={KUKU_PUPIL_RADIUS}
        fill="var(--color-kuku-mark-pupil)"
      />
      <circle cx="574.35" cy="548.118" r="7.5" fill="var(--color-kuku-mark-spark)" />
      <path
        d="M530.567 659.966L535.896 689.489L427.601 709.035L422.272 679.512L530.567 659.966ZM542.261 643.121C540.839 635.24 533.297 630.005 525.416 631.427L417.121 650.973C409.24 652.396 404.005 659.937 405.427 667.818C406.849 675.699 414.391 680.934 422.272 679.512L427.601 709.035C403.415 713.4 380.269 697.333 375.904 673.147C371.607 649.339 387.109 626.539 410.665 621.669L411.792 621.45L520.088 601.904L521.22 601.715C544.992 598.043 567.487 613.985 571.784 637.792L571.974 638.925C575.587 662.32 560.205 684.477 537.023 689.271L535.896 689.489L530.567 659.966C538.448 658.543 543.683 651.002 542.261 643.121Z"
        fill="var(--color-kuku-mark-mouth)"
      />
    </svg>
  );
}
