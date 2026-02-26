// just a navbar

"use client";

import { useState } from "react";
import { navlinks } from "@/constants/navbar.constants";
import Link from "next/link";
import { LucideIcon, LucideLayers } from "lucide-react";

const Navbar = () => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-50 bg-gray-900 border-b border-gray-800">
      <div className="relative flex items-center justify-between px-8 py-4 z-50 bg-gray-900">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-blue-500" />
          <span className="text-2xl font-bold tracking-tighter text-gray-100">
            Repo<span className="text-blue-500">Orbit</span>
          </span>
        </div>

        <ul className="hidden md:flex items-center gap-4 font-semibold">
          {navlinks.map(
            ({
              title,
              link,
              icon: Icon,
            }: {
              title: string;
              link: string;
              icon: LucideIcon;
            }) => (
              <Link key={title} href={link}>
                <li className="flex items-center gap-2 border-2 border-gray-600 text-gray-300 px-3 py-1 rounded-full hover:border-blue-500 transition-colors duration-300 cursor-pointer text-sm">
                  {Icon && <Icon size={14} className="text-blue-500" />}
                  {title}
                </li>
              </Link>
            ),
          )}

          <li>
            <Link href={"/workspace"}>
              <button className="flex items-center gap-2 text-gray-300 border-2 border-blue-700 px-3 py-1 rounded-full bg-blue-700 hover:bg-blue-600 hover:border-blue-600 transition-colors duration-300 cursor-pointer text-sm">
                <LucideLayers size={14} />
                Get started
              </button>
            </Link>
          </li>
        </ul>

        <button
          className="md:hidden p-2 text-gray-400 hover:text-white transition-colors focus:outline-none"
          onClick={() => setIsOpen(!isOpen)}
        >
          <div className="w-6 h-4 relative flex flex-col justify-between">
            <span
              className={`w-full h-0.5 bg-current transition-all duration-300 ${isOpen ? "rotate-45 translate-y-[7px]" : ""}`}
            />
            <span
              className={`w-full h-0.5 bg-current transition-all duration-300 ${isOpen ? "opacity-0" : ""}`}
            />
            <span
              className={`w-full h-0.5 bg-current transition-all duration-300 ${isOpen ? "-rotate-45 -translate-y-[7px]" : ""}`}
            />
          </div>
        </button>
      </div>

      <div
        className={`
            absolute right-8 top-full bg-gray-900 border-2 border-gray-700 rounded-2xl shadow-2xl
            transition-all duration-300 ease-in-out md:hidden overflow-hidden
            ${isOpen ? "max-h-[500px] opacity-100 translate-y-4" : "max-h-0 opacity-0 translate-y-0 pointer-events-none"}
          `}
      >
        <ul className="flex flex-col gap-4 p-6 font-semibold items-end">
          {navlinks.map(
            ({
              title,
              link,
              icon: Icon,
            }: {
              title: string;
              link: string;
              icon: LucideIcon;
            }) => (
              <Link
                key={title}
                href={link}
                onClick={() => setIsOpen(false)}
                className="w-full"
              >
                <li className="border-2 border-gray-600 text-gray-300 px-4 py-2 rounded-full hover:border-blue-500 transition-colors duration-300 cursor-pointer text-center text-sm">
                  {Icon && <Icon size={14} className="text-blue-500" />}
                  {title}
                </li>
              </Link>
            ),
          )}
          <li className="w-full pt-2">
            <button className="flex items-center gap-2 text-gray-300 border-2 border-blue-700 px-3 py-1 rounded-full bg-blue-700 hover:bg-blue-600 hover:border-blue-600 transition-colors duration-300 cursor-pointer text-sm">
              <LucideLayers size={14} />
              Get started
            </button>
          </li>
        </ul>
      </div>
    </nav>
  );
};

export default Navbar;
