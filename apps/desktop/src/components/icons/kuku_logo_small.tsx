import { createEffect, createSignal, on, onCleanup } from "solid-js";

interface KukuLogoSmallProps {
  size?: number;
  class?: string;
  isAiResponding?: boolean;
}

const LEFT_EYE = { cx: 389.242, cy: 427.242 };
const RIGHT_EYE = { cx: 518.205, cy: 453.758 };
const EYE_RADIUS = 89.1895;
const PUPIL_RADIUS = 30.7342;
const MAX_PUPIL_OFFSET = EYE_RADIUS - PUPIL_RADIUS - 30;

export function KukuLogoSmall(props: KukuLogoSmallProps) {
  const [pupilOffset, setPupilOffset] = createSignal({ x: 0, y: 0 });
  const [mouthScale, setMouthScale] = createSignal(1);

  createEffect(
    on(
      () => props.isAiResponding,
      (responding) => {
        if (!responding) {
          setPupilOffset({ x: 0, y: 0 });
          return;
        }

        const animateEyes = () => {
          const angle = Math.random() * Math.PI * 2;
          const radius = MAX_PUPIL_OFFSET * (0.5 + Math.random() * 0.5);
          setPupilOffset({
            x: Math.cos(angle) * radius,
            y: Math.sin(angle) * radius,
          });
        };

        animateEyes();
        const interval = setInterval(animateEyes, 400);
        onCleanup(() => clearInterval(interval));
      },
    ),
  );

  createEffect(
    on(
      () => props.isAiResponding,
      (responding) => {
        if (!responding) {
          setMouthScale(1);
          return;
        }

        const animateMouth = () => {
          setMouthScale(0.6 + Math.random() * 0.8);
        };

        animateMouth();
        const interval = setInterval(animateMouth, 150);
        onCleanup(() => clearInterval(interval));
      },
    ),
  );

  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 20}
      height={props.size ?? 20}
      viewBox="0 0 1080 1080"
      fill="none"
      class={props.class}
    >
      <path
        d="M285.659 184.338C312.48 182.739 343.379 186.996 375.084 193.487C406.883 199.998 440.662 209.018 473.144 217.384C505.892 225.819 537.346 233.597 565.49 238.017C593.846 242.469 619.367 244.707 642.888 246.504C666.193 248.285 688.125 249.665 708.236 252.423C749.248 258.046 784.916 269.662 817.956 303.378C882.891 369.64 888.924 473.009 877.135 560.067C864.724 651.718 818.877 690.918 759.981 754.189C731.042 785.278 703.458 818.978 673.774 844.684C643.383 871.002 608.969 890.757 564.362 894.334C477.505 901.3 388.514 852.969 333.349 785.903C304.28 750.564 297.968 720.247 295.852 685.534C293.771 651.404 295.544 615.052 284.174 561.15C278.585 534.656 268.295 504.591 256.47 472.816C244.803 441.469 231.509 408.129 220.756 376.751C209.991 345.337 201.204 314.342 198.714 286.854C196.24 259.549 199.734 232.907 216.858 213.133C233.838 193.526 258.894 185.934 285.659 184.338Z"
        fill="#121212"
        stroke="var(--color-kuku-mark-stroke)"
        stroke-width="30"
      />
      <circle
        cx={LEFT_EYE.cx}
        cy={LEFT_EYE.cy}
        r={EYE_RADIUS}
        fill="white"
        stroke="#121212"
        stroke-width="24.1053"
      />
      <circle
        cx={RIGHT_EYE.cx}
        cy={RIGHT_EYE.cy}
        r={EYE_RADIUS}
        fill="white"
        stroke="#121212"
        stroke-width="24.1053"
      />
      <circle
        cx={LEFT_EYE.cx + pupilOffset().x}
        cy={LEFT_EYE.cy + pupilOffset().y}
        r={PUPIL_RADIUS}
        fill="#121212"
        style={{ transition: "cx 0.3s ease-in-out, cy 0.3s ease-in-out" }}
      />
      <circle
        cx={RIGHT_EYE.cx + pupilOffset().x}
        cy={RIGHT_EYE.cy + pupilOffset().y}
        r={PUPIL_RADIUS}
        fill="#121212"
        style={{ transition: "cx 0.3s ease-in-out, cy 0.3s ease-in-out" }}
      />
      <rect
        x="355.128"
        y="571.756"
        width="169.044"
        height={59 * mouthScale()}
        rx="29.5"
        transform="rotate(7.1769 355.128 571.756)"
        fill="#121212"
        stroke="var(--color-kuku-mark-stroke)"
        stroke-width="30"
        style={{ transition: "height 0.1s ease-out" }}
      />
      <circle cx="540.5" cy="540.5" r="7.5" fill="white" />
    </svg>
  );
}
