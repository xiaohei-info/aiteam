import { forwardRef, type AnchorHTMLAttributes } from "react";
import { Link } from "react-router-dom";

type RouterLinkAdapterProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> & {
  href: string;
};

export const RouterLinkAdapter = forwardRef<
  HTMLAnchorElement,
  RouterLinkAdapterProps
>(function RouterLinkAdapter({ href, ...props }, ref) {
  return <Link ref={ref} to={href} {...props} />;
});
